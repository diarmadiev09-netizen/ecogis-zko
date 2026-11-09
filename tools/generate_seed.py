"""Builds web/data.json — all data the site shows.

Input: a geoBoundaries ADM2 GeoJSON for Kazakhstan (CC BY 4.0), e.g.
https://github.com/wmgeolab/geoBoundaries/raw/main/releaseData/gbOpen/KAZ/ADM2/geoBoundaries-KAZ-ADM2_simplified.geojson

Usage:  python tools/generate_seed.py path/to/geoBoundaries-KAZ-ADM2_simplified.geojson
The measurements are synthetic demo values; replace them with real ones in data.json
(or change the generator) when you have them.
"""
import json
import math
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# geoBoundaries still uses pre-2018 names for two districts.
# id: (geoBoundaries name, ru: (name, short, center, sources), kk: (name, short, center, sources))
DISTRICTS = {
    'taskala': ('Taskalinskiy',
        ('Таскалинский район', 'Таскала', 'с. Тасқала', ['Распашка земель, ветровая эрозия', 'Агрохимикаты в стоке малых рек']),
        ('Тасқала ауданы', 'Тасқала', 'Тасқала ауылы', ['Жерді жырту, жел эрозиясы', 'Шағын өзендер ағынындағы агрохимикаттар'])),
    'bayterek': ('Zelenovskiy',
        ('Байтерекский район', 'Байтерек', 'с. Перемётное', ['Пригородная застройка Уральска', 'Полигоны твёрдых бытовых отходов', 'Сбросы в р. Урал выше города']),
        ('Бәйтерек ауданы', 'Бәйтерек', 'Перемётное ауылы', ['Орал маңындағы құрылыс', 'Қатты тұрмыстық қалдықтар полигондары', 'Қаладан жоғары Жайыққа ағызындылар'])),
    'burlin': ('Burlinskiy',
        ('Бурлинский район', 'Бурлин', 'г. Аксай', ['Карачаганакское нефтегазоконденсатное месторождение', 'Факельное сжигание попутного газа', 'Выбросы H₂S и SO₂ у сёл санитарной зоны']),
        ('Бөрлі ауданы', 'Бөрлі', 'Ақсай қаласы', ['Қарашығанақ мұнай-газ конденсаты кен орны', 'Ілеспе газды алауда жағу', 'Санитарлық аймақ ауылдарындағы H₂S және SO₂ шығарындылары'])),
    'terekty': ('Terektinskiy',
        ('Теректинский район', 'Теректы', 'с. Фёдоровка', ['Транзитный транспорт', 'Животноводческие комплексы']),
        ('Теректі ауданы', 'Теректі', 'Федоровка ауылы', ['Транзиттік көлік', 'Мал шаруашылығы кешендері'])),
    'shyngyrlau': ('Chingirlauskiy',
        ('Шынгырлауский район', 'Шынгырлау', 'с. Шынгырлау', ['Деградация пастбищ', 'Сток с полей в р. Илек']),
        ('Шыңғырлау ауданы', 'Шыңғырлау', 'Шыңғырлау ауылы', ['Жайылымдардың тозуы', 'Егістіктерден Елек өзеніне ағын'])),
    'kaztal': ('Kaztalovskiy',
        ('Казталовский район', 'Казталов', 'с. Казталовка', ['Деградация пастбищ', 'Засоление почв', 'Пересыхание озёр Камыш-Самарской системы']),
        ('Қазталов ауданы', 'Қазталов', 'Қазталов ауылы', ['Жайылымдардың тозуы', 'Топырақтың тұздануы', 'Қамыс-Самар көлдерінің тартылуы'])),
    'syrym': ('Syrymskiy',
        ('Сырымский район', 'Сырым', 'с. Жымпиты', ['Перевыпас скота', 'Ветровая эрозия']),
        ('Сырым ауданы', 'Сырым', 'Жымпиты ауылы', ['Малды шамадан тыс жаю', 'Жел эрозиясы'])),
    'karatobe': ('Karatobinskiy',
        ('Каратобинский район', 'Каратобе', 'с. Каратобе', ['Засоление почв', 'Пыльные бури в летний сезон']),
        ('Қаратөбе ауданы', 'Қаратөбе', 'Қаратөбе ауылы', ['Топырақтың тұздануы', 'Жазғы шаңды дауылдар'])),
    'zhanibek': ('Dzhanybekskiy',
        ('Жанибекский район', 'Жанибек', 'с. Жанибек', ['Засоление и солонцы', 'Пыльные бури']),
        ('Жәнібек ауданы', 'Жәнібек', 'Жәнібек ауылы', ['Тұздану және сортаңдар', 'Шаңды дауылдар'])),
    'akzhaik': ('Akzhaikskiy',
        ('Акжаикский район', 'Акжаик', 'с. Чапаев', ['Нижнее течение р. Урал: накопление загрязнений', 'Пастбищная нагрузка в пойме']),
        ('Ақжайық ауданы', 'Ақжайық', 'Чапаев ауылы', ['Жайықтың төменгі ағысы: ластаудың жинақталуы', 'Жайылмадағы жайылым жүктемесі'])),
    'bokey': ('Urdinskiy',
        ('Бокейординский район', 'Бокейорда', 'с. Сайхин', ['Опустынивание, пески Рын', 'Пыльные бури', 'Перевыпас']),
        ('Бөкей ордасы ауданы', 'Бөкей ордасы', 'Сайқын ауылы', ['Шөлейттену, Нарын құмы', 'Шаңды дауылдар', 'Малды шамадан тыс жаю'])),
    'zhangala': ('Dzhangalinskiy',
        ('Жангалинский район', 'Жангала', 'с. Жангала', ['Опустынивание', 'Соры и засоление', 'Пересыхание р. Кушум']),
        ('Жаңақала ауданы', 'Жаңақала', 'Жаңақала ауылы', ['Шөлейттену', 'Сорлар және тұздану', 'Көшім өзенінің тартылуы'])),
}
URALSK = ('uralsk',
    ('г. Уральск', 'Уральск', 'областной центр', ['Автотранспорт', 'ТЭЦ и печное отопление частного сектора', 'Сбросы в реки Урал и Шаган']),
    ('Орал қаласы', 'Орал', 'облыс орталығы', ['Автокөлік', 'ЖЭО және жеке сектордың пешпен жылытуы', 'Жайық пен Шаған өзендеріне ағызындылар']))
URALSK_CENTER, URALSK_RADIUS_KM = (51.37, 51.23), 9

STATIONS = [  # name ru, name kk, lon, lat
    ('Уральск — центр', 'Орал — орталық', 51.37, 51.23), ('Уральск — север', 'Орал — солтүстік', 51.33, 51.26),
    ('Уральск — юг', 'Орал — оңтүстік', 51.40, 51.20), ('Аксай', 'Ақсай', 53.03, 51.17),
    ('Карачаганак', 'Қарашығанақ', 53.20, 51.35), ('Бурлин — санитарная зона', 'Бөрлі — санитарлық аймақ', 52.90, 51.25),
    ('Чапаев', 'Чапаев', 51.17, 50.20), ('Сайхин', 'Сайқын', 46.80, 48.82), ('Жанибек', 'Жәнібек', 46.85, 49.42),
    ('Теректы — центр района', 'Теректі — аудан орталығы', 51.73, 50.79), ('Жангала', 'Жаңақала', 49.98, 49.22),
    ('Каратобе', 'Қаратөбе', 53.48, 49.70), ('Тасқала', 'Тасқала', 50.30, 51.10), ('Жымпиты', 'Жымпиты', 52.20, 50.25),
    ('Казталовка', 'Қазталов', 48.70, 49.77), ('Шынгырлау', 'Шыңғырлау', 54.08, 51.10), ('Перемётное', 'Перемётное', 50.85, 51.20),
]

# Предприятия I категории ЗКО по данным https://ecokarta.kz/company (Ассоциация экологических
# организаций Казахстана). Координат там нет, только район: district_id None = район не указан.
ECOKARTA_URL = 'https://ecokarta.kz/company'
ENTERPRISES = [  # name, ОКЭД / вид деятельности, district_id
    ('АО «Карачаганак Петролиум Оперейтинг Б.В.»', '0610 — Добыча углеводородного сырья (нефти)', 'burlin'),
    ('АО «Конденсат»', '19201 — Производство продуктов нефтепереработки', 'burlin'),
    ('АО «Компания Монтажспецстрой»', '43298 — Строительно-монтажные работы', 'burlin'),
    ('ТОО «Болашак-Т»', '43298 — Строительно-монтажные работы', 'terekty'),
    ('ТОО «ХЭЛП-ЭКОЙЛ»', '38220 — Обработка и удаление опасных отходов', 'bayterek'),
    ('ТОО «АГРОПРОДУКТ ЛТД»', '10130 — Производство продуктов из мяса и мяса птицы', 'uralsk'),
    ('ТОО «Гидромаш-Орион-МЖБК»', '23611 — Производство железобетонных изделий', 'uralsk'),
    ('ТОО «ДСК ПРИОРИТЕТ»', '4211 — Строительство автомобильных дорог', 'uralsk'),
    ('ТОО «Карповский Северный»', 'Геологоразведка', 'uralsk'),
    ('ТОО «Уральская птицефабрика»', '01472 — Производство яиц', 'uralsk'),
    ('ТОО «Жаикмунай»', '06100 — Добыча сырой нефти и попутного газа', 'uralsk'),
    ('АО «ЗККСМ»', '28759 — Производство строительных материалов', 'uralsk'),
    ('К/Х «Щапово»', '01460 — Разведение свиней', 'uralsk'),
    ('ТОО «БАТЫС ПАУЭР»', '35140 — Производство и продажа электроэнергии', None),
]

# Demo baselines per district: AQI, ИЗВ, soil degradation %, peak NDVI, annual precipitation mm
BASE = {
    'taskala': (40, 1.3, 20, .40, 330), 'bayterek': (55, 2.1, 15, .45, 320), 'burlin': (112, 1.9, 22, .42, 330),
    'terekty': (50, 1.6, 16, .44, 300), 'shyngyrlau': (38, 1.2, 21, .40, 300), 'kaztal': (44, 1.7, 33, .28, 250),
    'syrym': (42, 1.5, 26, .34, 260), 'karatobe': (45, 1.8, 30, .30, 240), 'zhanibek': (48, 2.0, 42, .21, 230),
    'akzhaik': (52, 2.9, 31, .29, 230), 'bokey': (58, 2.2, 48, .17, 200), 'zhangala': (55, 2.3, 45, .19, 210),
    'uralsk': (110, 2.4, 18, .30, 320),
}
# share of the annual precipitation falling in each month (early-summer maximum)
PRECIP_SHARE = [.075, .06, .06, .07, .09, .11, .10, .08, .07, .09, .09, .09]
DESERT = {'bokey', 'zhangala', 'zhanibek', 'kaztal', 'karatobe', 'akzhaik'}
MONTHS = [(2025 + i // 12, i % 12 + 1) for i in range(22)]  # Jan 2025 .. Oct 2026


def r(x, n=5):
    return round(x, n)


def uralsk_ring():
    lon0, lat0 = URALSK_CENTER
    dlat = URALSK_RADIUS_KM / 111.32
    dlon = dlat / math.cos(math.radians(lat0))
    ring = [[r(lon0 + dlon * math.cos(a * math.pi / 16)), r(lat0 + dlat * math.sin(a * math.pi / 16))] for a in range(32)]
    return ring + [ring[0]]


def point_in_ring(x, y, ring):
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def contains(geom, x, y):
    polys = [geom['coordinates']] if geom['type'] == 'Polygon' else geom['coordinates']
    return any(point_in_ring(x, y, p[0]) and not any(point_in_ring(x, y, h) for h in p[1:]) for p in polys)


def air_s(did, m):
    s = 1.3 if (m >= 11 or m <= 3) else 1.05 if m == 4 else .9 if 5 <= m <= 8 else 1.0
    if did in DESERT and 6 <= m <= 8:
        s += .2
    return s


def water_s(m):
    return {4: 1.25, 5: 1.15, 8: 1.08}.get(m, 1.0)


def ndvi_s(m):
    return .35 + .65 * math.exp(-((m - 6) ** 2) / 5)


def feature(did, ru, kk, geom, is_city):
    return dict(id=did, name=ru[0], short=ru[1], center=ru[2], sources=ru[3],
                name_kk=kk[0], short_kk=kk[1], center_kk=kk[2], sources_kk=kk[3], is_city=is_city, geom=geom)


def main(src):
    gb = {f['properties']['shapeName']: f['geometry'] for f in json.load(open(src, encoding='utf8'))['features']}
    features = []
    for did, (gb_name, ru, kk) in DISTRICTS.items():
        assert gb_name in gb, f'{gb_name} not found in source'
        geom = gb[gb_name]
        polys = [geom['coordinates']] if geom['type'] == 'Polygon' else geom['coordinates']
        geom = {'type': 'MultiPolygon', 'coordinates': [[[[r(x), r(y)] for x, y, *_ in ring] for ring in poly] for poly in polys]}
        features.append(feature(did, ru, kk, geom, False))
    did, ru, kk = URALSK
    features.append(feature(did, ru, kk, {'type': 'MultiPolygon', 'coordinates': [[uralsk_ring()]]}, True))

    # Same rule as the database trigger: smallest containing district wins
    def area(f):
        return sum(abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(p[0], p[0][1:]))) for p in f['geom']['coordinates'])
    stations = []
    for i, (name, name_kk, lon, lat) in enumerate(STATIONS, 1):
        hits = sorted((f for f in features if contains(f['geom'], lon, lat)), key=area)
        assert hits, f'station {name} is outside the oblast'
        stations.append(dict(id=i, name=name, name_kk=name_kk, kind='multi', district_id=hits[0]['id'], lon=lon, lat=lat))
    without = {f['id'] for f in features} - {s['district_id'] for s in stations}
    assert not without, f'districts without a station: {without}'

    rng = random.Random(1444)
    measurements = []
    for s in stations:
        aqi0, wpi0, soil0, ndvi0, prec0 = BASE[s['district_id']]
        for t, (y, m) in enumerate(MONTHS):
            n = lambda k: 1 + k * (rng.random() * 2 - 1)
            date = f'{y}-{m:02d}-15'
            measurements += [
                (s['id'], 'aqi', round(aqi0 * air_s(s['district_id'], m) * n(.12)), date),
                (s['id'], 'wpi', round(wpi0 * water_s(m) * n(.12), 2), date),
                (s['id'], 'soil', round(soil0 + t * (.12 if s['district_id'] in DESERT else .03) + 1.5 * (rng.random() * 2 - 1), 1), date),
                (s['id'], 'ndvi', round(ndvi0 * ndvi_s(m) * n(.06), 3), date),
                (s['id'], 'precip', round(prec0 * PRECIP_SHARE[m - 1] * (.4 + 1.2 * rng.random()), 1), date),
            ]

    # ---- web/data.json: everything the site shows
    groups = {}
    for sid, k, v, d in measurements:
        key = (stations[sid - 1]['district_id'], d[:8] + '01', k)
        groups.setdefault(key, []).append(v)
    monthly = [dict(district_id=a, month=b, metric=c, value=round(sum(v) / len(v), 3), n=len(v)) for (a, b, c), v in groups.items()]
    props = ('name', 'short', 'center', 'sources', 'name_kk', 'short_kk', 'center_kk', 'sources_kk', 'is_city')
    demo = {
        'districts': {'type': 'FeatureCollection', 'features': [
            {'type': 'Feature', 'id': f['id'], 'properties': {p: f[p] for p in props}, 'geometry': f['geom']}
            for f in sorted(features, key=lambda f: (f['is_city'], f['id']))]},
        'stations': stations,
        'monthly': monthly,
        'enterprises': [dict(name=n, oked=o, category=1, district_id=d, source_url=ECOKARTA_URL) for n, o, d in ENTERPRISES],
    }
    (ROOT / 'web' / 'data.json').write_text(json.dumps(demo, ensure_ascii=False, separators=(',', ':')), encoding='utf8')
    print(f'{len(features)} districts, {len(stations)} stations, {len(measurements)} measurements')


if __name__ == '__main__':
    main(sys.argv[1])
