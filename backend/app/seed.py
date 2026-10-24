"""Демо-данные: справочники, пользователи всех ролей, клиенты и ~2.5 года истории проектов.

Запуск: python -m app.seed  (повторный запуск ничего не меняет, если пользователи уже есть)
"""

import random
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.db import SessionLocal
from app.models import (
    STAGE_DEFAULT_PROBABILITY,
    Client,
    Project,
    ReferenceValue,
    Role,
    Segment,
    Service,
    Stage,
    User,
)
from app.reference_data import REFERENCE_DATA, SPEC_SEGMENTS, SPEC_SERVICES

DEMO_PASSWORD = "Demo2026!"

SEGMENTS = ["Крупный бизнес", "Средний и малый бизнес", "Госсектор", "Операторы связи"]
SERVICES = {
    # услуга: (медианная сумма контракта, ₽, средняя маржинальность)
    "Интернет и VPN": (1_800_000, 0.42),
    "Облачные сервисы": (4_500_000, 0.35),
    "ЦОД и колокация": (9_000_000, 0.28),
    "Видеонаблюдение": (3_200_000, 0.30),
    "Информационная безопасность": (6_000_000, 0.38),
    "IoT-решения": (2_500_000, 0.33),
    "Телефония": (900_000, 0.45),
}
USERS = [
    ("analyst@example.com", "Анна Аналитикова", Role.analyst),
    ("head@example.com", "Олег Руководов", Role.admin),
    ("manager1@example.com", "Мария Продажина", Role.user),
    ("manager2@example.com", "Иван Сделкин", Role.user),
    ("manager3@example.com", "Елена Клиентова", Role.user),
    ("admin@example.com", "Администратор", Role.admin),
]
NAME_PREFIX = ["ООО", "АО", "ПАО", "ГБУ", "МУП"]
NAME_ROOT = [
    "Северная логистика",
    "ТехноСфера",
    "ГорСвет",
    "Агрохолдинг Поле",
    "Медицинский центр Здоровье",
    "Энергосбыт Восток",
    "Строймонтаж",
    "Транспортная компания Магистраль",
    "Фармация Плюс",
    "Банк Развитие",
    "Ритейл Групп",
    "Порт Балтика",
    "Университет Технологий",
    "Областная больница №2",
    "Металлург",
    "Телеком Регион",
    "Девелопер Квартал",
    "Пищекомбинат Нива",
    "Водоканал",
    "Аэропорт Сокол",
    "Школа будущего",
    "Цифровой регион",
    "Логистический парк",
    "Химпром",
    "Автодор",
    "Гостиница Волга",
    "Сеть аптек Доктор",
    "Нефтесервис",
    "Машзавод",
    "Кинотеатры Премьер",
]
PROJECT_TEMPLATES = [
    "Подключение филиалов",
    "Модернизация сети",
    "Переезд в облако",
    "Резервный канал",
    "Видеоаналитика на объектах",
    "Защита от DDoS",
    "Колокация серверов",
    "Умный учёт ресурсов",
    "IP-телефония для офисов",
    "Wi-Fi для посетителей",
    "SOC-мониторинг",
    "Частное облако",
    "Миграция ИТ-инфраструктуры",
    "Видеонаблюдение периметра",
    "SD-WAN",
]


def generate_inn(rng: random.Random) -> str:
    digits = [rng.randint(0, 9) for _ in range(9)]
    coefs = [2, 4, 10, 3, 5, 9, 4, 6, 8]
    control = sum(c * d for c, d in zip(coefs, digits, strict=False)) % 11 % 10
    return "".join(map(str, digits + [control]))


def seed(db: Session, today: date | None = None, projects_count: int = 1400) -> None:
    if db.scalar(select(User.id).limit(1)) is not None:
        print("База уже заполнена — пропускаю")
        return

    rng = random.Random(42)
    today = today or date.today()

    # 1. Безопасное добавление Сегментов
    existing_segments = set(db.scalars(select(Segment.name)).all())
    segments = [Segment(name=n) for n in dict.fromkeys(SEGMENTS + SPEC_SEGMENTS) if n not in existing_segments]

    # 2. Безопасное добавление Услуг
    existing_services = set(db.scalars(select(Service.name)).all())
    services = {
        name: Service(name=name, group_name=SPEC_SERVICES.get(name))
        for name in dict.fromkeys(list(SERVICES) + list(SPEC_SERVICES))
        if name not in existing_services
    }

    # 3. Безопасное добавление Справочных значений (Защита от UniqueViolation)
    existing_refs = set(db.execute(select(ReferenceValue.category, ReferenceValue.code)).all())

    references = []
    for category, items in REFERENCE_DATA.items():
        for code, name, position, probability in items:
            # Проверяем пару (category, code) на уникальность перед добавлением
            if (category, code) not in existing_refs:
                references.append(
                    ReferenceValue(category=category, code=code, name=name, position=position, probability=probability)
                )

    # Сохраняем только уникальные или новые объекты
    db.add_all(segments + list(services.values()) + references)
    db.flush()

    # Пересоздаем словарь услуг из БД для корректной привязки ID к проектам ниже
    all_services = {s.name: s for s in db.scalars(select(Service)).all()}
    # Пересоздаем список сегментов для корректной привязки ID к клиентам
    all_segments = db.scalars(select(Segment)).all()

    password_hash = hash_password(DEMO_PASSWORD)
    users = [User(email=e, full_name=n, role=r, password_hash=password_hash) for e, n, r in USERS]
    db.add_all(users)
    db.flush()
    managers = [u for u in users if u.role == Role.user]

    inns: set[str] = set()
    clients = []
    for i, root in enumerate(NAME_ROOT):
        inn = generate_inn(rng)
        while inn in inns:
            inn = generate_inn(rng)
        inns.add(inn)
        prefix = "ГБУ" if "больница" in root or "Школа" in root else NAME_PREFIX[i % 3]
        clients.append(Client(name=f"{prefix} «{root}»", inn=inn, segment=all_segments[i % len(all_segments)]))
    db.add_all(clients)
    db.flush()

    history_days = int(365 * 2.5)
    open_stages = [Stage.lead, Stage.qualification, Stage.proposal, Stage.negotiation]
    used_names: set[tuple[int, str]] = set()
    for _ in range(projects_count):
        # Степень < 1 сдвигает даты к сегодняшнему дню — число проектов растёт год к году
        start = today - timedelta(days=int(history_days * (1 - rng.random() ** 0.85)))
        client = rng.choice(clients)
        service_name = rng.choice(list(SERVICES))
        median, margin = SERVICES[service_name]
        amount = Decimal(round(median * rng.lognormvariate(0, 0.6), -3))
        cost = (amount * Decimal(1 - margin + rng.uniform(-0.1, 0.1))).quantize(Decimal("1"))

        base = rng.choice(PROJECT_TEMPLATES)
        name = base
        n = 2
        while (client.id, name) in used_names:
            name = f"{base} — этап {n}"
            n += 1
        used_names.add((client.id, name))

        duration = rng.randint(30, 240)
        planned_close = start + timedelta(days=duration)
        # Фактическое закрытие отличается от планового; если оно ещё не наступило — проект в работе
        closed_at = max(planned_close + timedelta(days=rng.randint(-20, 40)), start)
        if closed_at <= today:
            stage = Stage.won if rng.random() < 0.38 else Stage.lost
        else:
            closed_at = None
            stage = rng.choices(open_stages, weights=[3, 3, 2, 1.5])[0]

        db.add(
            Project(
                name=name,
                description=f"{base} для клиента {client.name}.",
                client_id=client.id,
                manager_id=rng.choice(managers).id,
                service_id=all_services[service_name].id,
                stage=stage,
                amount=amount,
                cost=cost,
                probability=STAGE_DEFAULT_PROBABILITY[stage],
                start_date=start,
                expected_close_date=max(planned_close, start),
                closed_at=closed_at,
            )
        )
    db.commit()
    print(f"Создано: {len(users)} пользователей, {len(clients)} клиентов, {projects_count} проектов")


if __name__ == "__main__":
    with SessionLocal() as session:
        seed(session)
