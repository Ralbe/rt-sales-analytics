"""Customer-specification lookup values shared by the seed and API."""

REFERENCE_DATA = {
    "cost_article": [
        ("goods", "Продажа товаров", 10, None),
        ("other_direct", "Прочие прямые", 20, None),
        ("subcontract", "Субподряд", 30, None),
        ("channel_rent", "Аренда каналов", 40, None),
        ("gph", "ГПХ", 50, None),
        ("gph_insurance", "СВ по ГПХ", 60, None),
        ("pip_t", "ПиПТ", 70, None),
        ("content", "Контент", 80, None),
        ("delivery", "Доставка счетов", 90, None),
        ("advertising", "Реклама", 100, None),
        ("commissions", "Комиссионные", 110, None),
        ("ruo", "РУО", 120, None),
        ("rsd", "РСД", 130, None),
        ("penalties", "Штрафы", 140, None),
    ],
    "cost_type": [
        ("direct", "Прямые", 10, None),
        ("commercial", "Коммерческие", 20, None),
        ("rsd", "РСД", 30, None),
        ("penalties", "Штрафы", 40, None),
    ],
    "revenue_status": [
        ("accrued", "начислена", 10, None),
        ("forecast", "прогнозное начисление", 20, None),
        ("planned", "начисление планируется", 30, None),
    ],
    "cost_status": [
        ("accrued", "начислены", 10, None),
        ("reserve", "создан резерв", 20, None),
        ("planned", "отражение планируется", 30, None),
    ],
    "payment_type": [
        ("installations", "Инсталляции", 10, None),
        ("service", "Сервисная", 20, None),
        ("equipment", "Оборудование", 30, None),
        ("one_time", "Разовые", 40, None),
        ("integration_projects", "Интеграционные проекты", 50, None),
    ],
    "assessment_status": [
        ("assessment", "ОЦЕНКА", 10, None),
        ("pkm", "ПКМ", 20, None),
        ("churn", "ОТТОК", 30, None),
        ("delete", "Delete", 40, None),
        ("dash_pkm", "ДАШ_ПКМ", 50, None),
    ],
    "project_indicator": [
        ("removed", "Снят", 10, None),
        ("new", "Новый", 20, None),
        ("transferred", "Перенос", 30, None),
        ("increased", "Увеличен", 40, None),
        ("reduced", "Снижен", 50, None),
        ("accepted_for_assessment", "Принят в оценку", 60, None),
        ("excluded_from_assessment", "Исключен из оценки", 70, None),
        ("implemented", "Реализован", 80, None),
    ],
    "customer_stage": [
        ("lead", "1. Лид", 10, 10),
        ("lead_work", "2. Проработка лида", 20, 10),
        ("proposal", "3. КП", 30, 30),
        ("pilot", "4. Пилот", 40, 40),
        ("funding", "5. Выделение финансирования", 50, 40),
        ("procurement", "6. Закупка/торги", 60, 50),
        ("contract_dd", "7. Заключение Д Д", 70, 70),
        ("contract_rd", "8. Заключение РД", 80, 80),
        ("delivery", "9. Реализация", 90, 90),
        ("success", "10. Успех", 100, 100),
    ],
}

SPEC_SEGMENTS = ["Крупный сегмент", "Госсектор", "Средний сегмент", "Малые предприятия"]
SPEC_SERVICES = {
    "Интернет": "Традиционный бизнес",
    "Телефония": "Традиционный бизнес",
    "Инфобез": "Кибербез",
    "Цифровые сервисы": "Новый телеком",
    "Облачные сервисы": "Новый телеком",
    "Отраслевые решения": "Проектная деятельность",
}
