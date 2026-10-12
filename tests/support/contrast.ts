/** sRGB channels in 0..255 and opacity in 0..1. Backgrounds must be opaque. */
export type Color = [number, number, number, number];

// Compose in sRGB without intermediate rounding, then linearize for WCAG relative luminance.
export function over(foreground: Color, background: Color): Color {
  const channels = foreground.slice(0, 3).map((channel, index) =>
    channel * foreground[3] + background[index] * (1 - foreground[3]));
  return [channels[0], channels[1], channels[2], 1];
}

export function luminance(rgb: Color): number {
  const channels = rgb.slice(0, 3).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

export function contrast(foreground: Color, background: Color): number {
  const text = luminance(over(foreground, background));
  const surface = luminance(background);
  return (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05);
}
