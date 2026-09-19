/**
 * Pick black or white text for a badge background so the label stays readable whatever color
 * the merchant chose (WCAG relative luminance / contrast ratio).
 */
function luminance(hex: string) {
  const channel = (offset: number) => {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function contrastRatio(hexA: string, hexB: string) {
  const [light, dark] = [luminance(hexA), luminance(hexB)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

export function readableTextColor(backgroundHex: string): "#000000" | "#FFFFFF" {
  return contrastRatio(backgroundHex, "#FFFFFF") >= contrastRatio(backgroundHex, "#000000")
    ? "#FFFFFF"
    : "#000000";
}
