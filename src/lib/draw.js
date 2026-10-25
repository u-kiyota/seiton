// ワークスペースのアイコン画像（色の角丸四角＋絵文字 / 名前の頭文字）を描く。
// サービスワーカー（ツールバーアイコン）とページ（ワークスペースタブの favicon）の両方から使うので chrome.* には触れない。
// OffscreenCanvas はどちらでも使える。

/**
 * label: indicatorLabel() の戻り値（{ text, emoji, color }）。size: 一辺の px。
 * 戻り値は ImageData。OffscreenCanvas が無い・2d context が取れない環境では例外を投げる（呼び出し側で既定アイコンにする）
 */
export function drawIndicatorIcon(label, size) {
  if (typeof OffscreenCanvas === 'undefined') throw new Error('OffscreenCanvas が使えません');
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas の 2d context が使えません');
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = label.color;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.22);
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (label.emoji) {
    ctx.font = `${Math.round(size * 0.72)}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
    ctx.fillStyle = '#000';
  } else {
    ctx.font = `bold ${Math.round(size * 0.68)}px system-ui, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", sans-serif`;
    ctx.fillStyle = '#fff';
  }
  ctx.fillText(label.text, size / 2, size / 2 + size * 0.04);
  return ctx.getImageData(0, 0, size, size);
}
