import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        shell: {
          950: "#081325",
          900: "#f4f8fc",
          800: "#cad8e8",
          700: "#6f829b"
        },
        signal: {
          mint: "#0f766e",
          amber: "#b36a13",
          coral: "#b94d3f",
          slate: "#334155"
        }
      },
      boxShadow: {
        pulse: "0 18px 48px rgba(11, 26, 46, 0.2)",
        soft: "0 20px 46px -30px rgba(11, 26, 46, 0.48)",
        lift: "0 30px 60px -36px rgba(11, 26, 46, 0.56)"
      },
      keyframes: {
        fadeRise: {
          "0%": { opacity: "0", transform: "translateY(16px)" },
          "100%": { opacity: "1", transform: "translateY(0)" }
        },
        floatOrb: {
          "0%, 100%": { transform: "translate3d(0, 0, 0)" },
          "50%": { transform: "translate3d(0, -10px, 0)" }
        }
      },
      animation: {
        "fade-rise": "fadeRise 560ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
        "float-orb": "floatOrb 12s ease-in-out infinite"
      },
    }
  },
  plugins: []
} satisfies Config;
