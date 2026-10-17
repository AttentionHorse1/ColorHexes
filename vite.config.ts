import { defineConfig } from "vite";
import { resolve } from "node:path";

// Dwie strony: tło (rejestruje narzędzie) i popover (ustawienia).
// `base` musi odpowiadać nazwie repozytorium na GitHub Pages:
// https://<użytkownik>.github.io/ColorHexes/
export default defineConfig({
  base: "/ColorHexes/",
  server: {
    // Owlbear Rodeo musi móc pobrać manifest i pliki z innej domeny.
    cors: true,
  },
  build: {
    rollupOptions: {
      input: {
        background: resolve(__dirname, "background.html"),
        popover: resolve(__dirname, "popover.html"),
      },
    },
  },
});
