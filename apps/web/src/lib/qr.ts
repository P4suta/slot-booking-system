import QRCode from "qrcode"

/**
 * Encode the canonical recovery URL for a ticket (ADR-0064) into a
 * data-URL PNG the `/ticket` page can drop into an `<img src>`.
 * The URL embeds the customer's anonymous handle (kana + last4) so
 * a scanner picks up the ticket on a different device without
 * re-typing.
 *
 * Sharing the QR is sharing the credential — the customer is
 * giving the recipient the same access they gave to themselves
 * (paper-number equivalent). The share-safe path lives at
 * `/recover?id=…`, which prompts for the handle on receipt.
 */
export const buildCanonicalRecoveryUrl = (
  origin: string,
  ticketId: string,
  nameKana: string,
  phoneLast4: string,
): string => {
  const params = new URLSearchParams({ id: ticketId, k: nameKana, p: phoneLast4 })
  return `${origin}/ticket?${params.toString()}`
}

export const renderQrToDataUrl = async (text: string): Promise<string> =>
  QRCode.toDataURL(text, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 320,
    color: {
      // Use OKLCH-compatible hex pairs sourced from app.css's
      // light-mode tokens; the QR encodes a URL the page will
      // recolor anyway. Dark mode reuses the same QR (the light
      // payload contrasts against the rendered dark surface) —
      // colour-inverted QRs trip about 5% of scanners.
      dark: "#1a1a1a",
      light: "#ffffff",
    },
  })

export const buildRecoveryShareUrl = (origin: string, ticketId: string): string =>
  `${origin}/recover?id=${encodeURIComponent(ticketId)}`
