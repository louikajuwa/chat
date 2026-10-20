/* Tailwind Play CDN configuration. Must load right after the CDN script. */
tailwind.config = {
  theme: {
    extend: {
      fontFamily: { sans: ['Plus Jakarta Sans', 'system-ui', 'sans-serif'] },
      colors: {
        ink: '#1a1a1a',
        paper: '#f7f6f3',
        line: '#e7e5e0',
        muted: '#6b6b6b',
        accent: '#ff5a36',
        danger: '#b42318',
      },
    },
  },
};
