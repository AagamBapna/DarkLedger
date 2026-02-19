import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        shell: {
          950: "#171b2d",
          900: "#ffffff",
          800: "#f3f5fb",
          700: "#dfe4f1"
        },
        signal: {
          mint: "#32c5b4",
          amber: "#e6ba58",
          coral: "#e38772",
          slate: "#6f7790"
        }
      },
      boxShadow: {
        pulse: "0 16px 48px rgba(37, 49, 98, 0.18)"
      }
    }
  },
  plugins: []
} satisfies Config;
