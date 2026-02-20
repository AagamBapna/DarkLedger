import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        shell: {
          950: "#10100f",
          900: "#fbfaf8",
          800: "#efede8",
          700: "#ccc8bf"
        },
        signal: {
          mint: "#3f8d66",
          amber: "#996f34",
          coral: "#9f4c44",
          slate: "#5c5a55"
        }
      },
      boxShadow: {
        pulse: "0 20px 45px rgba(16, 16, 15, 0.18)"
      }
    }
  },
  plugins: []
} satisfies Config;
