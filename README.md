# Hex Ranges

Rozszerzenie do Owlbear Rodeo: podczas przeciągania tokenu pokazuje zasięgi (ruch, atak, czary…) na siatce heksagonalnej.
Każdy zasięg ma własną nazwę, liczbę heksów i kolor, a listę można dowolnie edytować.

## Użycie

Działa tak jak oficjalne rozszerzenie Ranges, tylko na siatce heksagonalnej.

1. Na pasku narzędzi wybierz **Measure**, a w jego menu tryb **Zasięgi hex** (obok Ruler, Movement itd.).
2. Naciśnij i przeciągnij **token**: rusza się od razu za myszką (z przyciąganiem do siatki), a kolorowe zasięgi
   zostają w miejscu startu, więc widać, ile pól token przeszedł.
3. Naciśnij i przeciągnij **puste miejsce**: zasięgi podążają za kursorem (sam pomiar, nic się nie przesuwa).
4. Na pasku narzędzia Measure jest też przycisk **Ustawienia zasięgów hex** (suwaki). Tam zmieniasz nazwy,
   liczby heksów, kolory, widoczność oraz dodajesz i usuwasz zasięgi.

Każdy zasięg jest osobnym pierścieniem (komórki między poprzednim a tym zasięgiem), więc kolory się nie nakładają ani nie mieszają.
Nad każdym zasięgiem jest etykieta z nazwą i odległością (liczba heksów razy skala siatki, np. 30ft).
Zasięgi widzisz tylko Ty (elementy lokalne), a ruch tokenu widzą wszyscy. Działa tylko na scenach z siatką **Hex**;
ustawienia zapisują się w metadanych pokoju.

Przeciągane są tokeny z warstw Character, Mount i Prop, które nie są zablokowane i które możesz przesuwać według uprawnień pokoju.

## Uruchomienie lokalne

```bash
npm install
npm test          # testy geometrii heksów
npm run build     # build do folderu dist/
npm run typecheck # opcjonalna kontrola typów
npm run dev       # serwer na http://localhost:5173
```

W Owlbear Rodeo: **Profil → Add Extension** i wklej `http://localhost:5173/ColorHexes/manifest.json`.

## Wdrożenie na GitHub Pages

Repozytorium zawiera workflow `.github/workflows/deploy.yml`, który po każdym pushu na `main` buduje projekt i publikuje go.

1. W repozytorium: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Wypchnij zmiany na `main` (albo uruchom workflow ręcznie w zakładce **Actions**).
3. Po zakończeniu workflow adres manifestu to:
   `https://<twoja-nazwa-użytkownika>.github.io/ColorHexes/manifest.json`

Jeśli zmienisz nazwę repozytorium, zmień też `base` w `vite.config.ts` oraz ścieżki w `public/manifest.json`.
Po aktualizacji rozszerzenia usuń je w Owlbear i dodaj ponownie (albo odśwież stronę), żeby pobrało nowy manifest.

## Struktura

| Plik | Rola |
| --- | --- |
| `public/manifest.json` | Manifest rozszerzenia (tylko strona w tle) |
| `src/background.ts` | Tryb w Measure, przycisk ustawień, przesuwanie tokenu, rysowanie zasięgów |
| `src/popover.ts`, `popover.html`, `src/popover.css` | Okno ustawień |
| `src/shared.ts` | Typy, wartości domyślne, zapis ustawień w metadanych pokoju |
| `src/hex.ts` | Czysta geometria heksów (bez SDK) |
| `test/hex.test.ts` | Testy geometrii |
