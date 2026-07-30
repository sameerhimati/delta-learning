import { createSystem, defaultConfig, defineConfig } from "@chakra-ui/react";

const config = defineConfig({
  cssVarsPrefix: "delta",
  globalCss: {
    "html, body": {
      bg: "#f5f5f7",
      color: "gray.900",
      lineHeight: "1.6",
    },
    // Headings are short; let them break on meaning rather than on width.
    "h1, h2, h3, h4": { textWrap: "balance" },
    p: { textWrap: "pretty" },
    "*:focus-visible": {
      outline: "2px solid",
      outlineColor: "brand.500",
      outlineOffset: "2px",
    },
  },
  theme: {
    tokens: {
      colors: {
        brand: {
          50: { value: "#f4f3ff" },
          100: { value: "#e8e7ff" },
          500: { value: "#625bf6" },
          600: { value: "#554ee8" },
          700: { value: "#4640c8" },
        },
        // One border grey and one ink, so panels stop each inventing their own.
        line: { value: "#e4e5e8" },
        ink: { value: "#15171c" },
      },
      radii: {
        panel: { value: "14px" },
        control: { value: "10px" },
      },
      shadows: {
        panel: { value: "0 1px 2px rgba(17,24,39,0.04), 0 10px 30px rgba(17,24,39,0.04)" },
      },
    },
  },
});

export const system = createSystem(defaultConfig, config);
