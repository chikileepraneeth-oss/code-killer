// Graphics quality presets (saved per browser).
export const QUALITY = {
  low: { label: 'Low', pixelRatio: 1, shadowSize: 0, shadowEvery: 0, lights: 4, spots: 2, reflect: false, reflectRes: 0 },
  medium: { label: 'Medium', pixelRatio: 1.25, shadowSize: 1024, shadowEvery: 3, lights: 6, spots: 3, reflect: true, reflectRes: 256 },
  high: { label: 'High', pixelRatio: 1.75, shadowSize: 2048, shadowEvery: 1, lights: 8, spots: 4, reflect: true, reflectRes: 512 },
};

export function getQualityKey() {
  try {
    const q = localStorage.getItem('ck-quality');
    if (q && QUALITY[q]) return q;
  } catch { /* private mode */ }
  return 'medium';
}

export function setQualityKey(q) {
  try {
    localStorage.setItem('ck-quality', q);
  } catch { /* private mode */ }
}

export function getQuality() {
  return QUALITY[getQualityKey()];
}
