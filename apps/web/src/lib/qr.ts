import QRCode from "qrcode"

/**
 * Encode the share-safe recovery URL (ADR-0069). The QR points at
 * `/recover` with no query string — a recipient scans, lands on the
 * form, and must type the handle (kana + last4) themselves. The
 * URL no longer carries PII; ADR-0064's "QR = credential" trade-off
 * is intentionally retired so the URL bar / browser history stop
 * leaking the customer's name and phone digits.
 */
export const buildShareRecoveryUrl = (origin: string): string => `${origin}/recover`

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
