import type { Role, UserStatus } from "./role";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  tenantId: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export type JwtTokenType = "access" | "2fa_challenge";

export interface JwtPayload {
  sub: string;
  tenantId: string | null;
  role: Role;
  tokenVersion: number;
  type: JwtTokenType;
}

export interface LoginUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  tenantId: string | null;
}

export interface LoginSuccessResponse {
  accessToken: string;
  user: LoginUser;
}

export interface TwoFactorChallengeResponse {
  requiresTwoFactor: true;
  challengeToken: string;
  user: Pick<LoginUser, "id" | "email" | "name">;
}

export type LoginResponse = LoginSuccessResponse | TwoFactorChallengeResponse;

export interface ForgotPasswordResponse {
  success: true;
  devResetUrl?: string;
}

export interface InviteDetails {
  email: string;
  name: string;
  role: Role;
  tenantId: string | null;
  tenantName: string | null;
}

export interface InviteUserRequest {
  email: string;
  name: string;
  role: Role;
  /** Required for super_admin when not viewing a specific entity. Omit for tenant admins. */
  tenantId?: string | null;
}

export interface InviteUserResponse {
  user: User;
  /** Dev-only invite URL when NODE_ENV is not production */
  devInviteUrl?: string;
}

export interface CreateUserRequest {
  email: string;
  name: string;
  role: Role;
  password: string;
  /** Required for super_admin when not viewing a specific entity. Omit for tenant admins. */
  tenantId?: string | null;
}

export interface CreateUserResponse {
  user: User;
}

export interface TwoFactorSetupResponse {
  secret: string;
  otpauthUrl: string;
}
