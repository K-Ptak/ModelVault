# ModelVault: menedżer biblioteki modeli 3D

## Uruchomienie
Rozpakuj `ModelVault-win-x64.zip` gdziekolwiek (np. `C:\Programy\ModelVault`) i odpal `ModelVault.exe`.
Bez instalacji. Przy pierwszym starcie wskaż folder z modelami.
(Windows SmartScreen może ostrzec o nieznanym wydawcy: „Więcej informacji” → „Uruchom mimo to”.)

## Jak to działa
- **Biblioteka to zwykły folder.** Podfoldery są kategoriami. Aplikacja niczego nie kopiuje
  ani nie przerabia, tylko pokazuje to, co jest na dysku.
- **Przenoszenie działa w obie strony.** Przeciągnięcie modelu na folder po lewej przenosi
  plik na dysku. Zmiany zrobione w Eksploratorze aplikacja wykrywa sama.
- **Tagi, status (do wydruku / wydrukowane), ulubione i notatki** są zapisywane w pliku
  `.modelvault.json` w głównym folderze biblioteki, więc wędrują razem z nim (pendrive, OneDrive, NAS).
  Jeśli przeniesiesz plik w Eksploratorze, tagi go „znajdą” po nazwie i rozmiarze.
- **Miniatury:** obrazek o tej samej nazwie co model (np. `smok.stl` + `smok.png`) ma pierwszeństwo.
  Potem miniatura osadzona w 3MF / G-code (Prusa, Bambu, Orca). W ostatniej kolejności aplikacja
  renderuje model sama. Miniatury trafiają do cache w `%APPDATA%\ModelVault`.
- **Podgląd 3D:** STL, 3MF, OBJ, PLY, G-code (ścieżki druku). Wymiary, objętość,
  szacowana waga w PLA przy 100% wypełnienia (górna granica, przydatna do wyceny).
- Inne pliki (STEP, SCAD, F3D, BLEND…) są na liście, ale bez podglądu 3D.

## Skróty
| Skrót | Akcja |
|---|---|
| klik / Ctrl+klik / Shift+klik | zaznacz / dodaj do zaznaczenia / zakres |
| strzałki | poruszanie po siatce |
| dwuklik / Enter | otwórz w domyślnym programie (slicerze) |
| F2 | zmień nazwę |
| Del | do Kosza |
| F | ulubione |
| Ctrl+F | szukaj (nazwa, ścieżka, tagi, notatki) |
| Ctrl+A | zaznacz wszystko |
| prawy przycisk | menu kontekstowe (pliki i foldery) |

Pliki przeciągnięte z Eksploratora do okna są **kopiowane** do bieżącego folderu.

## Kod źródłowy
Electron + three.js. Z folderu źródeł:
```
npm install
npm start
```
