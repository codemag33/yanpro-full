// Сворачивание нижнего листа свайпом вниз: потянули лист вниз за ручку —
// он уезжает за экран, карта открывается, внизу остаётся пилюля-кнопка.
// Тап по пилюле разворачивает лист обратно.

export function initSheetCollapse(sheet: HTMLElement, bar: HTMLElement, barLabel: () => string) {
  let startY = 0;
  let pulling = false;
  let dy = 0;

  // Порог адаптивный: ~треть высоты листа, но не менее 80px и не более 150px,
  // чтобы на маленьком экране жест срабатывал с коротким свайпом.
  const threshold = () =>
    Math.min(150, Math.max(80, Math.round(sheet.getBoundingClientRect().height * 0.3)));

  const targetIsHandle = (e: PointerEvent) =>
    e.target instanceof HTMLElement && !!e.target.closest('.dragHandle');

  sheet.addEventListener('pointerdown', (e) => {
    if (!targetIsHandle(e)) return;
    // не перехватываем жест, если содержимое листа прокручено и пользователь
    // пролистывает его вверх (небольшой допуск на точность касания)
    if (sheet.scrollTop > 2) return;
    pulling = true;
    dy = 0;
    startY = e.clientY;
    try {
      sheet.setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    sheet.style.transition = 'none';
    sheet.style.willChange = 'transform';
  });

  sheet.addEventListener('pointermove', (e) => {
    if (!pulling) return;
    dy = Math.max(0, e.clientY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  });

  const finishPull = () => {
    if (!pulling) return;
    pulling = false;
    sheet.style.transition = 'transform .28s cubic-bezier(.2,.8,.2,1)';
    if (dy >= threshold()) collapse();
    else sheet.style.transform = '';
    sheet.style.willChange = '';
    dy = 0;
  };
  sheet.addEventListener('pointerup', finishPull);
  sheet.addEventListener('pointercancel', finishPull);

  function collapse() {
    sheet.classList.add('sheetCollapsed');
    sheet.style.transform = '';
    bar.textContent = barLabel();
    bar.classList.remove('hidden');
  }
  function expand() {
    sheet.classList.remove('sheetCollapsed');
    bar.classList.add('hidden');
    sheet.style.transform = '';
    sheet.scrollTop = 0;
  }

  bar.addEventListener('click', expand);

  return { collapse, expand };
}