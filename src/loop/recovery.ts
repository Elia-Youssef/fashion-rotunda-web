/**
 * Every lifecycle fact must hold before quality recovery may qualify.
 * The post chain adds its governor and fallback requirements separately.
 */
export function recoveryEligible(
  contentOnScreen: boolean,
  tierSettled: boolean,
  revealSettled: boolean,
  pageActive: boolean,
  documentVisible: boolean,
  noRendererError: boolean,
): boolean {
  return contentOnScreen && tierSettled && revealSettled && pageActive && documentVisible && noRendererError;
}

/** Page lifecycle and renderer failure survive post-chain rebuilds. */
export class RecoveryEligibility {
  /** Pagehide remains in force until pageshow. */
  pageActive = true;
  private rendererError = false;

  /** Once a renderer error is observed, later successful observations cannot clear it. */
  setRendererError(error: boolean): void {
    this.rendererError ||= error;
  }

  /** Visibility is read at the call site so tab restoration never uses a stale snapshot. */
  eligible(
    contentOnScreen: boolean,
    tierSettled: boolean,
    revealSettled: boolean,
    documentVisible: boolean,
  ): boolean {
    return recoveryEligible(
      contentOnScreen,
      tierSettled,
      revealSettled,
      this.pageActive,
      documentVisible,
      !this.rendererError,
    );
  }
}
