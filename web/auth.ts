export type Config = { region: string; clientId: string; local?: boolean };
export type Session = { accessToken: string; refreshToken?: string };
export type AuthResult = { AuthenticationResult?: { AccessToken: string; RefreshToken?: string }; ChallengeName?: string; Session?: string; ChallengeParameters?: { USER_ID_FOR_SRP?: string } };
export async function cognito(config: Config, operation: string, input: object): Promise<AuthResult> {
  const response = await fetch(`https://cognito-idp.${config.region}.amazonaws.com/`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${operation}` }, body: JSON.stringify(input),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const kind = String(error.__type || '').split('#').at(-1);
    throw new Error(kind === 'PasswordResetRequiredException' ? 'Your password needs resetting. Use Forgot password below.' : kind === 'TooManyRequestsException' ? 'Too many attempts. Wait a moment and try again.' : kind === 'InvalidPasswordException' ? 'Use at least 12 characters with uppercase, lowercase, a number and a symbol.' : operation === 'ForgotPassword' || operation === 'ConfirmForgotPassword' ? 'Could not reset the password. Check your email and verification code.' : 'Could not sign in. Check your email and password.');
  }
  return response.json();
}
export function restoreSession(): Session | null { try { return JSON.parse(sessionStorage.getItem('stock-session') || 'null'); } catch { return null; } }
export function saveSession(value: Session | null) { if (value) sessionStorage.setItem('stock-session', JSON.stringify(value)); else sessionStorage.removeItem('stock-session'); }
