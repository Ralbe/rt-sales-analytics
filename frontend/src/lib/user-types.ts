import type { Role, User } from "./types";

export interface ManagedUser extends User {
  is_active: boolean;
  created_at: string;
}

export interface UserPage {
  items: ManagedUser[];
  total: number;
  page: number;
  size: number;
}

export interface UserFields {
  email: string;
  full_name: string;
  role: Role;
  is_active: boolean;
}

export type UserSubmission = UserFields & { password?: string };
