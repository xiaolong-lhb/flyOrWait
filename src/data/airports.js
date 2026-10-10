/**
 * 常用机场 / 城市列表（MVP 阶段用固定列表，后续可替换为 API 动态搜索）
 *
 * code  —— IATA 三字码，作为表单与接口的实际传参
 * city  —— 中文城市名，用于界面展示
 * type  —— domestic 国内 / region 中国港澳台 / international 国际
 */
export const AIRPORTS = [
  // 国内
  { code: 'SZX', city: '深圳', type: 'domestic' },
  { code: 'CAN', city: '广州', type: 'domestic' },
  { code: 'PVG', city: '上海', type: 'domestic' },
  { code: 'SHA', city: '上海', type: 'domestic' },
  { code: 'PEK', city: '北京', type: 'domestic' },
  { code: 'PKX', city: '北京', type: 'domestic' },
  { code: 'CTU', city: '成都', type: 'domestic' },
  { code: 'TFU', city: '成都', type: 'domestic' },
  { code: 'HGH', city: '杭州', type: 'domestic' },
  { code: 'CKG', city: '重庆', type: 'domestic' },
  { code: 'XIY', city: '西安', type: 'domestic' },
  { code: 'KMG', city: '昆明', type: 'domestic' },
  { code: 'XMN', city: '厦门', type: 'domestic' },
  { code: 'NKG', city: '南京', type: 'domestic' },
  { code: 'CSX', city: '长沙', type: 'domestic' },
  { code: 'WUH', city: '武汉', type: 'domestic' },
  { code: 'TAO', city: '青岛', type: 'domestic' },
  { code: 'LJG', city: '丽江', type: 'domestic' },

  // 中国港澳台
  { code: 'HKG', city: '中国香港', type: 'region' },
  { code: 'MFM', city: '中国澳门', type: 'region' },
  { code: 'TPE', city: '中国台湾', type: 'region' },

  // 国际
  { code: 'TYO', city: '东京', type: 'international' },
  { code: 'OSA', city: '大阪', type: 'international' },
  { code: 'SEL', city: '首尔', type: 'international' },
  { code: 'BKK', city: '曼谷', type: 'international' },
  { code: 'SIN', city: '新加坡', type: 'international' },
  { code: 'KUL', city: '吉隆坡', type: 'international' },
  { code: 'HKT', city: '普吉岛', type: 'international' },
  { code: 'DPS', city: '巴厘岛', type: 'international' },
  { code: 'HAN', city: '河内', type: 'international' },
  { code: 'SGN', city: '胡志明市', type: 'international' },
  { code: 'DXB', city: '迪拜', type: 'international' },
  { code: 'LON', city: '伦敦', type: 'international' },
  { code: 'PAR', city: '巴黎', type: 'international' },
  { code: 'NYC', city: '纽约', type: 'international' },
  { code: 'LAX', city: '洛杉矶', type: 'international' },
  { code: 'SYD', city: '悉尼', type: 'international' },
];

/** 按三字码查机场，找不到返回 undefined */
export function findAirport(code) {
  return AIRPORTS.find((a) => a.code === code);
}

/** 界面展示用文案：深圳 SZX */
export function airportLabel(code) {
  const a = findAirport(code);
  return a ? `${a.city} ${a.code}` : code || '';
}
