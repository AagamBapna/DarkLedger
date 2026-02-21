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
          700: "#6f829b",
        },
        signal: {
          mint: "#0f766e",
          amber: "#b36a13",
          coral: "#b94d3f",
          slate: "#334155",
        },
        dash: {
          bg: "#F0F4FA",
          sidebar: "#FFFFFF",
          card: "#FFFFFF",
          navy: "#1E293B",
          accent: "#14B8A6",
          "accent-hover": "#0D9488",
          muted: "#64748B",
          border: "#E2E8F0",
          "border-hover": "#CBD5E1",
          danger: "#EF4444",
          success: "#10B981",
          purple: "#8B5CF6",
          pink: "#F472B6",
          orange: "#F97316",
        },
      },
      boxShadow: {
        pulse: "0 18px 48px rgba(11, 26, 46, 0.2)",
        soft: "0 20px 46px -30px rgba(11, 26, 46, 0.48)",
        lift: "0 30px 60px -36px rgba(11, 26, 46, 0.56)",
        card: "0 1px 3px rgba(0,0,0,0.04), 0 6px 16px -4px rgba(0,0,0,0.06)",
        "card-hover": "0 4px 12px rgba(0,0,0,0.06), 0 16px 32px -8px rgba(0,0,0,0.1)",
        sidebar: "4px 0 24px -2px rgba(0,0,0,0.06)",
        glow: "0 0 20px rgba(20, 184, 166, 0.15)",
      },
      borderRadius: {
        "2xl": "1rem",
        "3xl": "1.5rem",
        "4xl": "2rem",
      },
      keyframes: {
        fadeRise: {
          "0%": { opacity: "0", transform: "translateY(16px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        floatOrb: {
          "0%, 100%": { transform: "translate3d(0, 0, 0)" },
          "50%": { transform: "translate3d(0, -10px, 0)" },
        },
        slideInLeft: {
          "0%": { opacity: "0", transform: "translateX(-12px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        scaleIn: {
          "0%": { opacity: "0", transform: "scale(0.95)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        barGrow: {
          "0%": { transform: "scaleY(0)" },
          "100%": { transform: "scaleY(1)" },
        },
        pulseDot: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.4" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        countUp: {
          "0%": { opacity: "0", transform: "translateY(10px) scale(0.96)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        slideRight: {
          "0%": { opacity: "0", transform: "translateX(-100%)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
      },
      animation: {
        "fade-rise": "fadeRise 560ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
        "float-orb": "floatOrb 12s ease-in-out infinite",
        "slide-in-left": "slideInLeft 400ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
        "slide-up": "slideUp 400ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
        "scale-in": "scaleIn 300ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
        "bar-grow": "barGrow 600ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
        "pulse-dot": "pulseDot 2s ease-in-out infinite",
        shimmer: "shimmer 2s linear infinite",
        "count-up": "countUp 600ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
        "slide-right": "slideRight 500ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
      },
    },
  },
  plugins: [],
} satisfies Config;
