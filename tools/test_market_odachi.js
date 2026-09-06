const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function check() {
  const url = `https://steamcommunity.com/market/listings/570/Fireborn%20Odachi/render/?query=&start=0&count=10&country=RU&language=english&currency=5`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://steamcommunity.com/market/listings/570/Fireborn%20Odachi'
    }
  });
  console.log('Status:', res.status);
  const text = await res.text();
  console.log('Response preview:', text.substring(0, 300));
}
check();
