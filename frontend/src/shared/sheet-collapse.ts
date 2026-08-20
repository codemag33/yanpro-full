// Сворачивание нижнего листа свайпом вниз: потянули лист вниз за ручку —
// он уезжает за экран, карта открывается, внизу остаётся пилюля-кнопка.
// Тап по пилюле разворачивает лист обратно.

export function initSheetCollapse(sheet: HTMLElement, bar: HTMLElement, barLabel: () => string) {
  const TRIGGER_PX = 110; // дальше порога — сворачиваем
  let startY = 0;
  let pulling = false;
  let dy = 0;

  const targetIsHandle = (e: PointerEvent) =>
    e.target instanceof HTMLElement && !!e.target.closest('.dragHandle');

  sheet.addEventListener('pointerdown', (e) => {
    if (!targetIsHandle(e)) return;
    // не перехватываем жест, если содержимое листа прокручено и пользователь
    // пролистывает его вверх
    if (sheet.scrollTop > 0) return;
    pulling = true;
    dy = 0;
    startY = e.clientY;
    try {
      sheet.setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    sheet.style.transition = 'none';
  });

  sheet.addEventListener('pointermove', (e) => {
    if (!pulling) return;
    dy = Math.max(0, e.clientY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  });

  const finishPull = () => {
    if (!pulling) return;
    pulling = false;
    sheet.style.transition = 'transform .32s cubic-bezier(.2,.8,.2,1)';
    if (dy >= TRIGGER_PX) collapse();
    else sheet.style.transform = '';
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