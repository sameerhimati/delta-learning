import { createSystem, defaultConfig, defineConfig } from "@chakra-ui/react";

const config = defineConfig({
  cssVarsPrefix: "delta",
  globalCss: {
    "html, body": {
      bg: "#f5f6f8",
      color: "gray.900",
      lineHeight: "1.6",
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
      },
    },
  },
});

export const system = createSystem(defaultConfig, config);
