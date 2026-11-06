// A setup requirement is recoverable. It is not an execution result and must not consume the payment.
export const ACCOUNT_UPGRADE_REQUIRED = 'BROWSER_ACCOUNT_UPGRADE_REQUIRED';

export function awaitingAccountUpgrade(step: { status: string; error_code: string | null }): boolean {
  return ['pending', 'approved'].includes(step.status) && step.error_code === ACCOUNT_UPGRADE_REQUIRED;
}
