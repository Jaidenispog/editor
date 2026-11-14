/**
 * What the Reviews page says above the automatic-requests switch (pure, so it can be tested without rendering): why it
 * can't be switched on, or a plain warning when it is on while Square also asks for feedback (settings saved before
 * the two were kept apart). Null when there is nothing to say.
 */
export function reviewAutomationNotice(input: { squareAsksForFeedback: boolean; automationEnabled: boolean; reviewLinkValid: boolean }): string | null {
  if (input.squareAsksForFeedback && input.automationEnabled) {
    return "Square is asking your clients for feedback and automatic review requests are also on, so clients could be asked twice. While both are on, no new requests are prepared and ones set to send by themselves are cancelled before they go. Switch automatic requests off here, or, if Square no longer asks, untick \"Feedback or review requests\" in Emails → Sending settings.";
  }
  if (input.squareAsksForFeedback) return 'Square is already asking your clients for feedback; turn that off in Square first to avoid asking twice.';
  if (!input.reviewLinkValid) return 'Add your Google review link above before switching this on.';
  return null;
}
