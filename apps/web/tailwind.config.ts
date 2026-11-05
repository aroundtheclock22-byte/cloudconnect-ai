import type { Config } from 'tailwindcss';
export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: { brand: { 50: '#eef4ff', 100: '#dbe7ff', 200: '#bfd3ff', 300: '#93b4fd', 400: '#6090fa', 500: '#3b6cf6', 600: '#2550eb', 700: '#1d3fd8', 800: '#1e35af', 900: '#1e338a' } },
      fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
    },
  },
  plugins: [],
} satisfies Config;
