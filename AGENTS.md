# AGENTS — агенты для работы с репозиторием

## roles

### fixer
- **Роль:** Реализация и исполнение
- **Сценарий:** Перегенерация видео из HTML, фиксы скриптов, правки README
- **Инструменты:** `playwright`, `ffmpeg`, `node`
- **Важно:** Не коммитить видеофайлы, только overview_final.*

### oracle
- **Роль:** Ревизия и валидация
- **Сценарий:** Проверка README ссылок, проверка полноты набора видео, валидация порядка сцен
- **Важно:** Сравнивать HTML в tests/ с *_labeled.mp4 в screenshots/

## workflows

### regenerate_videos
1. `node record_all.js` — перегенерировать все 33 видео
2. `ffmpeg concat` — создать overview_final.mp4
3. `ffmpeg palettegen + paletteuse` — создать overview_final.gif
4. Python/PIL — создать overview_grid.png
5. Проверить что все 33 *_labeled.mp4 на месте

### update_readme
1. Обновить ссылки на overview_final.*
2. Проверить что все ссылки на HTML и PNG работают
3. Убедиться что текст актуален

## commands

### Запустить генерацию видео
```bash
cd /workspace/pelicans-test && node record_all.js
```

### Создать overview
```bash
cd /workspace/pelicans-test/screenshots
ls *_labeled.mp4 | grep -v overview > filelist.txt
ffmpeg -f concat -safe 0 -i filelist.txt -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p -b:v 15M overview_final.mp4
ffmpeg -i overview_final.mp4 -vf "fps=10,scale=854:-1:flags=lanczos,palettegen" palette.png
ffmpeg -i overview_final.mp4 -i palette.png -filter_complex "fps=10,scale=854:-1:flags=lanczos[x];[x][1:v]paletteuse" overview_final.gif
```

### Проверить полноту
```bash
cd /workspace/pelicans-test
echo "HTML: $(find tests -name '*.html' | wc -l)"
echo "MP4: $(ls screenshots/*_labeled.mp4 | wc -l)"
echo "Missing: $(comm -23 <(ls tests/**/*.html 2>/dev/null | sed 's|tests/||;s|\.html$|_labeled.mp4|' | sort) <(ls screenshots/*_labeled.mp4 | xargs -n1 basename | sort) | wc -l)"
```
