import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        shell: {
          950: "#07140f",
          900: "#0c2218",
          800: "#123126",
          700: "#1a4333"
        },
        signal: {
          mint: "#69ffa7",
          amber: "#ffcb66",
          coral: "#ff8f77",
          slate: "#b9ccc2"
        }
      },
      boxShadow: {
        pulse: "0 10px 40px rgba(105, 255, 167, 0.18)"
      }
    }
  },
  plugins: []
} satisfies Config;
