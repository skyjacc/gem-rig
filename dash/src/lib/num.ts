// Число с пробелами между тысячами. Отдельно от api.ts: чистые модели
// экранов (v2/sales/model.ts) проверяются тестами в Node, а api.ts тянет
// React, снимок показа и import.meta.env.
export const nf = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
