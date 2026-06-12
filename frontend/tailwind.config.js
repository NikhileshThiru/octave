/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Fraunces"', "ui-serif", "Georgia", "serif"],
        sans: ['"Manrope"', "ui-sans-serif", "system-ui", "sans-serif"],
      },
      colors: {
        onyx: "#07070B",
        smoke: "#13141B",
        bone: "#F5F2EC",
        ember: "#FF6A4D",
      },
      animation: {
        "aurora-drift": "aurora-drift 28s ease-in-out infinite alternate",
        "fade-up": "fade-up 0.7s cubic-bezier(.16,.84,.34,1) both",
        "cover-in": "cover-in 0.8s cubic-bezier(.16,.84,.34,1) both",
      },
      keyframes: {
        "aurora-drift": {
          "0%":   { transform: "translate3d(-3%, -2%, 0) scale(1)" },
          "50%":  { transform: "translate3d(2%, 3%, 0) scale(1.05)" },
          "100%": { transform: "translate3d(-1%, -3%, 0) scale(1.02)" },
        },
        "fade-up": {
          "0%":   { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "cover-in": {
          "0%":   { opacity: "0", transform: "translateY(14px) scale(0.92)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
      },
      letterSpacing: {
        widest2: "0.42em",
      },
    },
  },
  plugins: [],
};
