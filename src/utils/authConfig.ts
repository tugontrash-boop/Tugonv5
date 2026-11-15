export type TugonAccountRole = 'official' | 'kagawad' | 'admin';

export interface TugonAccountDefinition {
  username: string;
  password: string;
  role: TugonAccountRole;
  label: string;
  isAdmin: boolean;
}

export const TUGON_ADMIN_MASTER_PASSWORD = 'TUGONADMINACCESS10-ZIRCON';
export const TUGON_BRGY_SHARED_PASSWORD = 'Brgy40&41@CaviteCity2026!';

export const TUGON_ACCOUNTS: readonly TugonAccountDefinition[] = [
  {
    username: 'Barangay40&41',
    password: TUGON_BRGY_SHARED_PASSWORD,
    role: 'official',
    label: 'Barangay 40 & 41 Official',
    isAdmin: false,
  },
  {
    username: 'Kagawad',
    password: TUGON_BRGY_SHARED_PASSWORD,
    role: 'kagawad',
    label: 'Barangay Kagawad',
    isAdmin: false,
  },
  {
    username: 'Kagawad41',
    password: TUGON_BRGY_SHARED_PASSWORD,
    role: 'kagawad',
    label: 'Kagawad 41',
    isAdmin: false,
  },
  {
    username: 'Admin',
    password: TUGON_ADMIN_MASTER_PASSWORD,
    role: 'admin',
    label: 'System Admin',
    isAdmin: true,
  },
];

export interface AuthVerificationResult {
  valid: boolean;
  username?: string;
  role?: TugonAccountRole;
  label?: string;
  isAdmin: boolean;
}

export function findTugonAccount(username?: string | null): TugonAccountDefinition | undefined {
  const cleanUser = String(username || '').trim().toLowerCase();
  if (!cleanUser) return undefined;
  return TUGON_ACCOUNTS.find((acc) => acc.username.toLowerCase() === cleanUser);
}

export function verifyTugonCredentials(
  usernameInput?: string | null,
  passwordInput?: string | null,
  customOfficialPassword?: string | null
): AuthVerificationResult {
  const cleanUser = String(usernameInput || '').trim();
  const cleanPass = String(passwordInput || '').trim();
  const cleanCustom = String(customOfficialPassword || '').trim();

  if (!cleanPass) {
    return { valid: false, isAdmin: false };
  }

  // If username is explicitly provided, validate strictly against the registered accounts
  if (cleanUser) {
    const account = findTugonAccount(cleanUser);
    if (!account) {
      return { valid: false, isAdmin: false };
    }

    // High-level Admin master key is strictly required for Admin, and can also authorize elevated access
    if (account.isAdmin) {
      if (cleanPass === TUGON_ADMIN_MASTER_PASSWORD) {
        return {
          valid: true,
          username: account.username,
          role: 'admin',
          label: account.label,
          isAdmin: true,
        };
      }
      return { valid: false, isAdmin: false };
    }

    const matchesAccountPass =
      cleanPass === account.password ||
      cleanPass === TUGON_ADMIN_MASTER_PASSWORD ||
      (Boolean(cleanCustom) && cleanPass === cleanCustom);

    if (!matchesAccountPass) {
      return { valid: false, isAdmin: false };
    }

    return {
      valid: true,
      username: account.username,
      role: account.role,
      label: account.label,
      isAdmin: cleanPass === TUGON_ADMIN_MASTER_PASSWORD,
    };
  }

  // Password-only verification fallback (e.g. legacy password checks or password reset modals)
  if (cleanPass === TUGON_ADMIN_MASTER_PASSWORD) {
    return {
      valid: true,
      username: 'Admin',
      role: 'admin',
      label: 'System Admin',
      isAdmin: true,
    };
  }

  if (
    cleanPass === TUGON_BRGY_SHARED_PASSWORD ||
    (Boolean(cleanCustom) && cleanPass === cleanCustom)
  ) {
    return {
      valid: true,
      username: 'Barangay40&41',
      role: 'official',
      label: 'Barangay 40 & 41 Official',
      isAdmin: false,
    };
  }

  return { valid: false, isAdmin: false };
}

export function isAuthorizedAdminPassword(passwordInput?: string | null): boolean {
  return String(passwordInput || '').trim() === TUGON_ADMIN_MASTER_PASSWORD;
}
