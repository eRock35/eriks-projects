// The free tier's playground.
//
// Every one of these is SAMPLE data, invented to be interesting to animate.
// They are labelled as such everywhere they appear, because a chart that
// looks authoritative and is not is the one thing this app must never ship.
// If a real dataset is ever added here, say where it came from.
//
// Each is chosen to show off a different animation, so someone who has not
// signed up still sees what the tool can do.
//
// Every one carries its own `spec` - the column mapping the model would
// otherwise be asked for. These datasets are fixed, so that answer is fixed
// too, and paying Opus to re-derive it on every click was a live cost leak:
// six buttons on a public page, any stranger, up to the global daily cap.
// Samples now cost nothing to serve and are therefore genuinely unlimited.

const DATASETS = [
  {
    id: 'city-visits',
    title: 'Three cities, five years',
    blurb: 'A lead changes hands twice. Best seen as a race.',
    best: 'race',
    hint: 'race the cities over time',
    csv: `year,city,visits
2019,Atlanta,120
2019,Denver,180
2019,Austin,90
2020,Atlanta,260
2020,Denver,190
2020,Austin,150
2021,Atlanta,410
2021,Denver,210
2021,Austin,320
2022,Atlanta,520
2022,Denver,250
2022,Austin,480
2023,Atlanta,610
2023,Denver,300
2023,Austin,700`,
    spec: { vizType: 'race', nameCol: 'city', timeCol: 'year', valueCol: 'visits', seriesCol: '', fromCol: '', toCol: '', valueFormat: 'number', valueLabel: 'visits', title: 'Austin overtakes Atlanta', subtitle: 'Visits by city, five years', note: '' },
  },
  {
    id: 'lending-mix',
    title: 'Lending book by product',
    blurb: 'Eight quarters of a portfolio shifting between products.',
    best: 'race',
    hint: 'race the products by balance',
    csv: `quarter,product,balance
2023Q1,Mortgage,2400
2023Q1,Auto,1800
2023Q1,Card,960
2023Q1,Consumer,520
2023Q2,Mortgage,2300
2023Q2,Auto,1950
2023Q2,Card,1100
2023Q2,Consumer,610
2023Q3,Mortgage,2150
2023Q3,Auto,2100
2023Q3,Card,1320
2023Q3,Consumer,700
2023Q4,Mortgage,2050
2023Q4,Auto,2260
2023Q4,Card,1540
2023Q4,Consumer,810
2024Q1,Mortgage,1980
2024Q1,Auto,2410
2024Q1,Card,1810
2024Q1,Consumer,905`,
    spec: { vizType: 'race', nameCol: 'product', timeCol: 'quarter', valueCol: 'balance', seriesCol: '', fromCol: '', toCol: '', valueFormat: 'compact', valueLabel: 'balance', title: 'Auto overtakes Mortgage', subtitle: 'Book balance by product, eight quarters', note: 'Sample data.' },
  },
  {
    id: 'hub-traffic',
    title: 'Traffic between hubs',
    blurb: 'Volume moving along routes. Watch the particles.',
    best: 'flow',
    hint: 'show the movement between hubs',
    csv: `from,to,trips
Atlanta,Denver,520
Atlanta,Austin,310
Denver,Seattle,240
Austin,Denver,160
Seattle,Atlanta,430
Denver,Austin,275
Austin,Seattle,120
Seattle,Denver,390`,
    spec: { vizType: 'flow', nameCol: '', timeCol: '', valueCol: 'trips', seriesCol: '', fromCol: 'from', toCol: 'to', valueFormat: 'number', valueLabel: 'trips', title: 'Traffic between hubs', subtitle: 'Volume along each route', note: '' },
  },
  {
    id: 'channels',
    title: 'Sessions by channel',
    blurb: 'A year of traffic sources. The lines draw themselves in.',
    best: 'line',
    hint: 'draw the channels over the year',
    csv: `month,channel,sessions
Jan,Search,4200
Jan,Social,1800
Jan,Direct,2400
Feb,Search,4400
Feb,Social,2100
Feb,Direct,2350
Mar,Search,5100
Mar,Social,3400
Mar,Direct,2500
Apr,Search,4900
Apr,Social,4100
Apr,Direct,2600
May,Search,5600
May,Social,5200
May,Direct,2700
Jun,Search,6100
Jun,Social,6400
Jun,Direct,2900`,
    spec: { vizType: 'line', nameCol: '', timeCol: 'month', valueCol: 'sessions', seriesCol: 'channel', fromCol: '', toCol: '', valueFormat: 'compact', valueLabel: 'sessions', title: 'Social catches Search', subtitle: 'Sessions by channel', note: '' },
  },
  {
    id: 'ticket-mix',
    title: 'Support tickets by cause',
    blurb: 'A single snapshot, ranked. Bars grow in.',
    best: 'bars',
    hint: 'rank the causes',
    csv: `cause,tickets
Login and access,1840
Billing questions,1310
Data import failed,960
Integration broken,720
Report is wrong,540
Feature request,410
Everything else,280`,
    spec: { vizType: 'bars', nameCol: 'cause', timeCol: '', valueCol: 'tickets', seriesCol: '', fromCol: '', toCol: '', valueFormat: 'number', valueLabel: 'tickets', title: 'What support actually spends its day on', subtitle: 'Tickets by cause', note: '' },
  },
  {
    id: 'launch-week',
    title: 'Launch week, hour by hour',
    blurb: 'A spike and a long tail, drawn over time.',
    best: 'line',
    hint: 'draw the signups over the week',
    csv: `hour,signups
Mon 09,12
Mon 12,48
Mon 15,96
Mon 18,140
Tue 09,310
Tue 12,520
Tue 15,480
Tue 18,390
Wed 09,260
Wed 12,220
Wed 15,190
Wed 18,175
Thu 09,150
Thu 12,140
Thu 15,132
Thu 18,128
Fri 09,120
Fri 12,118
Fri 15,112
Fri 18,108`,
    spec: { vizType: 'line', nameCol: '', timeCol: 'hour', valueCol: 'signups', seriesCol: '', fromCol: '', toCol: '', valueFormat: 'number', valueLabel: 'signups', title: 'A spike and a long tail', subtitle: 'Signups through launch week', note: '' },
  },
];

function list() {
  return DATASETS.map((d) => ({ id: d.id, title: d.title, blurb: d.blurb, best: d.best, sample: true }));
}

function get(id) {
  return DATASETS.find((d) => d.id === id) || null;
}

/** True when a sample can be served without asking the model anything. */
function isFree(ds) {
  return Boolean(ds && ds.spec && ds.spec.vizType);
}

module.exports = { list, get, isFree, DATASETS };
