// The company set, and the names the extractor looks for.
//
// `layer` places a company on the map: equipment -> chips -> devices ->
// cloud. `aliases` are the strings a filing uses for that company; they are
// matched as whole words. `filer: false` marks a company that files nothing
// with the SEC that this app reads: it only ever appears on the map when a
// document from a company in the set (or its own public list) names it.

const FILERS = [
  { id: 'AAPL', cik: 320193, name: 'Apple', legal: 'Apple Inc.', layer: 'devices', form: '10-K', aliases: ['Apple'] },
  { id: 'MSFT', cik: 789019, name: 'Microsoft', legal: 'Microsoft Corporation', layer: 'cloud', form: '10-K', aliases: ['Microsoft'] },
  { id: 'GOOGL', cik: 1652044, name: 'Alphabet', legal: 'Alphabet Inc.', layer: 'cloud', form: '10-K', aliases: ['Alphabet', 'Google'] },
  { id: 'AMZN', cik: 1018724, name: 'Amazon', legal: 'Amazon.com, Inc.', layer: 'cloud', form: '10-K', aliases: ['Amazon', 'AWS'] },
  { id: 'META', cik: 1326801, name: 'Meta', legal: 'Meta Platforms, Inc.', layer: 'cloud', form: '10-K', aliases: ['Meta Platforms', 'Meta', 'Facebook'] },
  { id: 'DELL', cik: 1571996, name: 'Dell', legal: 'Dell Technologies Inc.', layer: 'devices', form: '10-K', aliases: ['Dell'] },
  { id: 'HPQ', cik: 47217, name: 'HP Inc.', legal: 'HP Inc.', layer: 'devices', form: '10-K', aliases: ['HP Inc.', 'HP'] },
  { id: 'CSCO', cik: 858877, name: 'Cisco', legal: 'Cisco Systems, Inc.', layer: 'devices', form: '10-K', aliases: ['Cisco'] },
  { id: 'NVDA', cik: 1045810, name: 'NVIDIA', legal: 'NVIDIA Corporation', layer: 'chips', form: '10-K', aliases: ['NVIDIA', 'Nvidia'] },
  { id: 'AMD', cik: 2488, name: 'AMD', legal: 'Advanced Micro Devices, Inc.', layer: 'chips', form: '10-K', aliases: ['AMD', 'Advanced Micro Devices'] },
  { id: 'INTC', cik: 50863, name: 'Intel', legal: 'Intel Corporation', layer: 'chips', form: '10-K', aliases: ['Intel'] },
  { id: 'QCOM', cik: 804328, name: 'Qualcomm', legal: 'QUALCOMM Incorporated', layer: 'chips', form: '10-K', aliases: ['Qualcomm', 'QUALCOMM'] },
  { id: 'AVGO', cik: 1730168, name: 'Broadcom', legal: 'Broadcom Inc.', layer: 'chips', form: '10-K', aliases: ['Broadcom'] },
  { id: 'MU', cik: 723125, name: 'Micron', legal: 'Micron Technology, Inc.', layer: 'chips', form: '10-K', aliases: ['Micron'] },
  { id: 'TXN', cik: 97476, name: 'Texas Instruments', legal: 'Texas Instruments Incorporated', layer: 'chips', form: '10-K', aliases: ['Texas Instruments'] },
  { id: 'TSM', cik: 1046179, name: 'TSMC', legal: 'Taiwan Semiconductor Manufacturing Company Limited', layer: 'chips', form: '20-F', aliases: ['TSMC', 'Taiwan Semiconductor Manufacturing'] },
  { id: 'AMAT', cik: 6951, name: 'Applied Materials', legal: 'Applied Materials, Inc.', layer: 'equipment', form: '10-K', aliases: ['Applied Materials'] },
  { id: 'LRCX', cik: 707549, name: 'Lam Research', legal: 'Lam Research Corporation', layer: 'equipment', form: '10-K', aliases: ['Lam Research'] },
  { id: 'ASML', cik: 937966, name: 'ASML', legal: 'ASML Holding N.V.', layer: 'equipment', form: '20-F', aliases: ['ASML'] },
];

// Companies outside the set. None of these is on the map unless a source
// names it; listing one here only tells the extractor what to look for.
const OTHERS = [
  { id: 'SAMSUNG', name: 'Samsung', layer: 'chips', aliases: ['Samsung'] },
  { id: 'SKHYNIX', name: 'SK hynix', layer: 'chips', aliases: ['SK hynix', 'SK Hynix', 'Hynix'] },
  { id: 'FOXCONN', name: 'Foxconn (Hon Hai)', layer: 'devices', aliases: ['Hon Hai', 'Foxconn'] },
  { id: 'LENOVO', name: 'Lenovo', layer: 'devices', aliases: ['Lenovo'] },
  { id: 'GFS', name: 'GlobalFoundries', layer: 'chips', aliases: ['GlobalFoundries', 'GLOBALFOUNDRIES', 'GF'] },
  { id: 'XIAOMI', name: 'Xiaomi', layer: 'devices', aliases: ['Xiaomi'] },
  { id: 'CANON', name: 'Canon', layer: 'equipment', aliases: ['Canon'] },
  { id: 'NIKON', name: 'Nikon', layer: 'equipment', aliases: ['Nikon'] },
  { id: 'OPENAI', name: 'OpenAI', layer: 'cloud', aliases: ['OpenAI'] },
  { id: 'ANTHROPIC', name: 'Anthropic', layer: 'cloud', aliases: ['Anthropic'] },
  { id: 'ARM', name: 'Arm', layer: 'chips', aliases: ['Arm Holdings', 'Arm Limited', 'Arm'] },
  { id: 'ZEISS', name: 'Carl Zeiss SMT', layer: 'equipment', aliases: ['Carl Zeiss', 'Zeiss'] },
  { id: 'WISTRON', name: 'Wistron', layer: 'devices', aliases: ['Wistron'] },
  { id: 'PEGATRON', name: 'Pegatron', layer: 'devices', aliases: ['Pegatron'] },
  { id: 'QUANTA', name: 'Quanta', layer: 'devices', aliases: ['Quanta'] },
  { id: 'FABRINET', name: 'Fabrinet', layer: 'devices', aliases: ['Fabrinet'] },
  { id: 'HUAWEI', name: 'Huawei', layer: 'devices', aliases: ['Huawei'] },
  { id: 'SONY', name: 'Sony', layer: 'devices', aliases: ['Sony'] },
  { id: 'KIOXIA', name: 'Kioxia', layer: 'chips', aliases: ['Kioxia', 'KIOXIA'] },
  { id: 'TEL', name: 'Tokyo Electron', layer: 'equipment', aliases: ['Tokyo Electron'] },
  { id: 'KLA', name: 'KLA', layer: 'equipment', aliases: ['KLA'] },
  { id: 'ASE', name: 'ASE', layer: 'chips', aliases: ['Advanced Semiconductor Engineering', 'ASE'] },
  { id: 'AMKOR', name: 'Amkor', layer: 'chips', aliases: ['Amkor'] },
  { id: 'UMC', name: 'UMC', layer: 'chips', aliases: ['United Microelectronics', 'UMC'] },
  { id: 'SMIC', name: 'SMIC', layer: 'chips', aliases: ['Semiconductor Manufacturing International', 'SMIC'] },
  { id: 'ORCL', name: 'Oracle', layer: 'cloud', aliases: ['Oracle'] },
  { id: 'COREWEAVE', name: 'CoreWeave', layer: 'cloud', aliases: ['CoreWeave'] },
  { id: 'SUPERMICRO', name: 'Supermicro', layer: 'devices', aliases: ['Super Micro', 'Supermicro'] },
  { id: 'HPE', name: 'HPE', layer: 'devices', aliases: ['Hewlett Packard Enterprise', 'HPE'] },
  { id: 'IBM', name: 'IBM', layer: 'cloud', aliases: ['IBM'] },
  { id: 'MEDIATEK', name: 'MediaTek', layer: 'chips', aliases: ['MediaTek'] },
  { id: 'WDC', name: 'Western Digital', layer: 'chips', aliases: ['Western Digital'] },
  { id: 'CXMT', name: 'CXMT', layer: 'chips', aliases: ['ChangXin', 'CXMT'] },
  { id: 'YMTC', name: 'YMTC', layer: 'chips', aliases: ['Yangtze Memory', 'YMTC'] },
  { id: 'ARISTA', name: 'Arista', layer: 'devices', aliases: ['Arista'] },
  { id: 'SYNOPSYS', name: 'Synopsys', layer: 'equipment', aliases: ['Synopsys'] },
  { id: 'CADENCE', name: 'Cadence', layer: 'equipment', aliases: ['Cadence'] },
  { id: 'VIS', name: 'Vanguard (VIS)', layer: 'chips', aliases: ['Vanguard International Semiconductor'] },
];

const LAYERS = [
  { id: 'equipment', name: 'Equipment', blurb: 'Machines that make chips' },
  { id: 'chips', name: 'Chips', blurb: 'Design and manufacture of chips' },
  { id: 'devices', name: 'Devices and systems', blurb: 'Phones, PCs, servers, networks, and who assembles them' },
  { id: 'cloud', name: 'Cloud and services', blurb: 'Data centres, software and online services' },
];

const byId = Object.fromEntries([...FILERS, ...OTHERS].map((c) => [c.id, c]));
module.exports = { FILERS, OTHERS, LAYERS, byId };
