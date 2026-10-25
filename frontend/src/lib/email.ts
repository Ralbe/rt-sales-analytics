// Совпадает с ASCII-форматом email в backend/app/user_schemas.py.
const EMAIL_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidUserEmail(value: string): boolean {
  const email = value.trim().toLowerCase();
  return email.length <= 255 && email.split("@", 1)[0].length <= 64 && EMAIL_PATTERN.test(email);
}
