"""Анализатор новостей и тактический инвестор — приложение «Глобус».

Atom раз в несколько минут читает ленты новостей (RSS/Atom без ключей) и сейсмику USGS, разбирает каждую новость
без модели и ставит маркер на глобус:

  где      — по справочнику мест (страны, столицы, моря и проливы, ru + en, в любом падеже — по основе слова);
  что      — категория: конфликт, катастрофа, экономика, энергетика, политика, технологии, здоровье;
  рынки    — правила «событие → рынок»: ОПЕК+ сокращает добычу → нефть ↑, ставка растёт → акции США ↓ и т.д.;
  прогноз  — в тексте явный прогноз («ожидается», «повысит», «expected to», «plans to»…) + влияние на рынок —
             это экономический маркер; такие сигналы пишутся в хранилище: Jarvis/News/Сигналы.md;
  важность — 0…1: категория, жертвы, «крупнейший/рекорд», магнитуда землетрясения.

Тактика (`tactics`): давление на каждый рынок — сумма сигналов за двое суток с затуханием (свежие весят больше),
и что это значит для активов владельца (Finance/Assets.md): какие позиции под ветром, а какие против. Это сценарии
для размышления, не инвестиционная рекомендация — так и пишется в ответе. Глубокий разбор — «Разбор Claude»
(через обычный разговор с мозгом, с поиском в интернете).

Только сервер: из браузера iPhone ленты недоступны (CORS), поэтому в JS-ядро не перенесено намеренно.
"""
from __future__ import annotations

import asyncio
import hashlib
import html
import json
import logging
import math
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Awaitable, Callable

log = logging.getLogger("jarvis.news")

DEFAULT_FEEDS = (
    "https://feeds.bbci.co.uk/news/world/rss.xml",
    "https://feeds.bbci.co.uk/news/business/rss.xml",
    "https://www.aljazeera.com/xml/rss/all.xml",
    "https://ria.ru/export/rss2/archive/index.xml",
    "https://tass.ru/rss/v2.xml",
    "https://www.interfax.ru/rss.asp",
)
QUAKES = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson"
MAX_ITEMS = 400
MAX_BYTES = 3 * 2**20
FRESH_HOURS = 48

# ---------- рынки: где «живут» (дуги на глобусе) и чем их видно (котировки без ключей, assets.Quotes) ----------
MARKETS: dict[str, dict] = {
    "oil": {"name": "Нефть", "hub": [51.51, -0.09], "hub_name": "ICE · Лондон", "quote": "stock:LKOH",
            "quote_label": "Лукойл"},
    "gas": {"name": "Газ", "hub": [52.37, 4.90], "hub_name": "TTF · Амстердам", "quote": "stock:GAZP",
            "quote_label": "Газпром"},
    "gold": {"name": "Золото", "hub": [47.37, 8.54], "hub_name": "Цюрих", "quote": "crypto:PAXG",
             "quote_label": "PAXG"},
    "rub": {"name": "Рубль", "hub": [55.76, 37.62], "hub_name": "ЦБ · Москва", "quote": "fx:USD",
            "quote_label": "USD/RUB", "invert": True},
    "moex": {"name": "Акции РФ", "hub": [55.75, 37.58], "hub_name": "Мосбиржа", "quote": "stock:SBER",
             "quote_label": "Сбер"},
    "us": {"name": "Акции США", "hub": [40.71, -74.01], "hub_name": "Нью-Йорк"},
    "rates": {"name": "Ставки", "hub": [38.89, -77.04], "hub_name": "ФРС · Вашингтон"},
    "crypto": {"name": "Крипта", "hub": [1.35, 103.82], "hub_name": "Сингапур", "quote": "crypto:BTC",
               "quote_label": "BTC"},
    "grain": {"name": "Зерно", "hub": [41.88, -87.63], "hub_name": "CBOT · Чикаго"},
    "chips": {"name": "Полупроводники", "hub": [24.80, 120.97], "hub_name": "Синьчжу"},
    "china": {"name": "Китай", "hub": [31.23, 121.47], "hub_name": "Шанхай"},
}

KINDS = {
    "conflict": "Конфликт", "disaster": "Катастрофа", "quake": "Землетрясение", "economy": "Экономика",
    "energy": "Энергетика", "politics": "Политика", "tech": "Технологии", "health": "Здоровье", "other": "Другое",
}
BASE_SEVERITY = {"conflict": .55, "disaster": .55, "quake": .4, "economy": .4, "energy": .45, "politics": .35,
                 "tech": .3, "health": .35, "other": .2}

# категория: основы слов (ru + en) — по первому совпадению в порядке приоритета
CATEGORY_WORDS: list[tuple[str, tuple[str, ...]]] = [
    ("disaster", ("землетряс", "цунами", "наводнен", "ураган", "тайфун", "извержен", "лесн пожар", "пожар",
                  "оползн", "крушен", "катастроф", "earthquake", "tsunami", "flood", "hurricane", "typhoon",
                  "cyclone", "wildfire", "eruption", "landslide", "crash", "disaster", "explosion", "взрыв")),
    ("conflict", ("войн", "обстрел", "удар", "атак", "ракет", "бпла", "дрон", "беспилотн", "военн", "армия",
                  "боев", "перестрел", "теракт", "наступлен", "эскалац", "вторжен", "war", "strike", "attack",
                  "missile", "drone", "military", "troops", "shelling", "invasion", "airstrike", "hamas",
                  "хамас", "хусит", "houthi", "hezbollah", "хезболл", "ceasefire", "перемири")),
    ("energy", ("нефт", "опек", "=газ", "=газа", "газов", "газопровод", "спг", "баррел", "нпз", "энергет",
                "oil", "opec", "crude",
                "brent", "lng", "pipeline", "refiner", "gasoline", "energy")),
    ("economy", ("ставк", "инфляц", "ввп", "рецесс", "экономик", "бирж", "акци", "рынок", "рынк", "курс",
                 "рубл", "доллар", "юан", "санкц", "пошлин", "тариф", "банк", "биткоин", "крипт", "золот",
                 "облигац", "дефолт", "бюджет", "rate", "inflation", "gdp", "recession", "economy", "stocks",
                 "market", "shares", "tariff", "sanction", "bitcoin", "crypto", "gold", "bond", "default",
                 "central bank", "federal reserve", "fed", "earnings", "imf", "мвф")),
    ("tech", ("искусствен интеллект", "нейросет", "чип", "полупроводник", "смартфон", "кибер", "хакер",
              "=ai", "=ии", "artificial intelligence", "chip", "semiconductor", "nvidia", "tsmc", "openai", "cyber",
              "hack", "spacex", "космос", "спутник", "satellite")),
    ("health", ("эпидем", "вирус", "вакцин", "пандем", "вспышк", "covid", "outbreak", "virus", "vaccine",
                "pandemic", "world health", "воз")),
    ("politics", ("выбор", "президент", "премьер", "парламент", "правительств", "министр", "переговор",
                  "саммит", "election", "president", "prime minister", "parliament", "government", "minister",
                  "talks", "summit", "protest", "протест", "митинг")),
]

# явный прогноз: будущее событие, а не уже случившееся
FORECAST = re.compile(
    r"\b(ожида\w*|прогноз\w*|намерен\w*|планиру\w*|собира\w+ся|может|могут|вероятн\w*|предупред\w*|"
    r"повысит|понизит|снизит|сократит|увеличит|введ[её]т|запрет\w*т|"
    r"к концу (?:года|месяца|квартала)|в (?:следующем|ближайш\w+)|"
    r"expected to|expects?|forecasts?|projected|predicts?|will likely|likely to|plans? to|set to|poised to|"
    r"warns?|could|may (?:raise|cut|hike|ban|impose|lift)|is to|are to|outlook)\b", re.I)

Rule = tuple  # (имя, группы основ, [(рынок, направление, уверенность)], пояснение[, «кроме» — основы-исключения])
# имя; группы основ — в каждой должна найтись хотя бы одна; эффекты; пояснение;
# если в тексте есть основа-исключение — правило не срабатывает
CBR = ("цб", "банк росс", "центробанк росс", "набиуллин", "ключев")
MARKET_RULES: list[Rule] = [
    ("opec_cut", (("опек", "opec"), ("сокра", "сниж", "cut", "reduc", "curb")),
     (("oil", 1, .75),), "ОПЕК+ сокращает добычу — меньше нефти на рынке"),
    ("opec_raise", (("опек", "opec"), ("увелич", "нарастит", "повыс", "raise", "increase", "boost", "hike output")),
     (("oil", -1, .65),), "ОПЕК+ наращивает добычу — нефти больше"),
    ("supply_route", (("ормуз", "hormuz", "красн мор", "red sea", "танкер", "tanker", "суэц", "suez",
                       "нпз", "refiner", "хусит", "houthi"),
                      ("атак", "удар", "блок", "перекр", "захват", "attack", "strike", "block", "seiz", "closure",
                       "disrupt", "пожар", "fire")),
     (("oil", 1, .7), ("gas", 1, .4)), "угроза поставкам нефти и СПГ"),
    ("mideast_war", (("иран", "iran", "израил", "israel", "сектор газ", "gaza", "ливан", "lebanon"),
                     ("войн", "удар", "атак", "ракет", "эскалац", "war", "strike", "attack", "missile", "escalat")),
     (("oil", 1, .55), ("gold", 1, .5)), "эскалация на Ближнем Востоке — премия за риск"),
    ("ceasefire", (("перемири", "ceasefire", "truce", "мирн соглаш", "peace deal", "мирн переговор",
                    "peace talks"),),
     (("oil", -1, .4), ("gold", -1, .35), ("moex", 1, .35)), "деэскалация снижает премию за риск",
     ("сорва", "провал", "зашли в тупик", "stall", "collapse", "fail", "violat", "наруш")),
    ("rate_hike", (("ставк", "rate"), ("повыс", "повыш", "подним", "hike", "raise", "increase")),
     (("rates", 1, .7), ("us", -1, .45), ("crypto", -1, .45), ("gold", -1, .3)), "дорогие деньги давят на риск", CBR),
    ("rate_cut", (("ставк", "rate"), ("сниз", "сниж", "пониз", "cut", "lower", "ease")),
     (("rates", -1, .7), ("us", 1, .45), ("crypto", 1, .45), ("gold", 1, .35)), "дешёвые деньги поддерживают риск",
     CBR),
    ("cbr_hike", (CBR, ("повыс", "повыш", "ужесточ")),
     (("rub", 1, .5), ("moex", -1, .45)), "ЦБ повышает ставку — рубль крепче, акциям тяжелее"),
    ("cbr_cut", (CBR, ("сниз", "сниж", "пониз", "смягч")),
     (("rub", -1, .4), ("moex", 1, .5)), "ЦБ снижает ставку — поддержка акциям, рублю слабее"),
    ("inflation_up", (("инфляц", "inflation"),
                      ("ускор", "рост", "выше", "рекорд", "rise", "higher", "hot", "surge", "jump")),
     (("rates", 1, .5), ("gold", 1, .35), ("us", -1, .3)), "инфляция выше — ставки дольше высокие"),
    ("recession", (("рецесс", "recession", "спад экономик", "slowdown", "contraction"),),
     (("us", -1, .5), ("oil", -1, .45), ("gold", 1, .4)), "риск рецессии — спрос падает"),
    ("tariffs", (("пошлин", "тариф", "tariff", "trade war", "торгов войн"),),
     (("china", -1, .5), ("us", -1, .35), ("chips", -1, .3)), "торговые барьеры бьют по экспортёрам"),
    ("sanctions_ru", (("санкц", "sanction"), ("росси", "russia", "российск", "русск", "moscow", "москв")),
     (("moex", -1, .55), ("rub", -1, .45), ("oil", 1, .3)), "новые санкции против России"),
    ("price_cap", (("потолок цен", "price cap"), ("нефт", "oil")),
     (("oil", 1, .3), ("moex", -1, .3)), "ограничение цены на российскую нефть"),
    ("gas_cut", (("=газ", "=газа", "=газу", "=газом", "газопровод", "газов", "=gas", "спг", "lng"),
                 ("прекрат", "прекращ", "останов", "сократ", "halt", "cut off", "stop")),
     (("gas", 1, .6),), "перебои с поставками газа"),
    ("rub_weak", (("рубл", "rouble", "ruble"), ("ослаб", "падени", "упал", "weaken", "fall", "slump")),
     (("rub", -1, .6),), "рубль слабеет"),
    ("rub_strong", (("рубл", "rouble", "ruble"), ("укрепл", "вырос", "strengthen", "rally")),
     (("rub", 1, .6),), "рубль крепнет"),
    ("crypto_etf", (("биткоин", "bitcoin", "крипт", "crypto", "ethereum", "эфир"),
                    ("etf", "одобр", "approve", "легализ", "резерв", "reserve")),
     (("crypto", 1, .6),), "институциональный спрос на крипту"),
    ("crypto_hack", (("биткоин", "bitcoin", "крипт", "crypto", "биржа", "exchange"),
                     ("взлом", "hack", "запрет", "ban", "банкрот", "bankrupt", "exploit")),
     (("crypto", -1, .6),), "взлом или запрет бьёт по крипте"),
    ("grain_shock", (("пшениц", "зерн", "урожа", "wheat", "grain", "corn", "кукуруз"),
                     ("засух", "неурожа", "запрет экспорт", "drought", "export ban", "blockade", "блокад")),
     (("grain", 1, .6),), "меньше зерна на рынке"),
    ("grain_glut", (("пшениц", "зерн", "урожа", "wheat", "grain"), ("рекорд", "record", "bumper")),
     (("grain", -1, .45),), "большой урожай давит на цены"),
    ("chips_shock", (("тайван", "taiwan", "tsmc", "чип", "полупроводник", "semiconductor", "chip"),
                     ("землетряс", "блокад", "ограничен экспорт", "export control", "earthquake", "blockade",
                      "дефицит", "shortage", "запрет", "ban")),
     (("chips", -1, .6), ("us", -1, .3)), "риск для цепочек поставок чипов"),
    ("ai_boom", (("nvidia", "=ии", "=ai", "искусствен интеллект", "нейросет"),
                 ("рекорд", "record", "выручк", "revenue", "beats", "превзош", "инвестиц", "investment")),
     (("chips", 1, .5), ("us", 1, .35)), "спрос на ИИ поддерживает техсектор"),
    ("china_stimulus", (("кита", "china", "chinese", "пекин", "beijing"),
                        ("стимул", "stimulus", "смягчен", "easing", "поддержк экономик")),
     (("china", 1, .55), ("oil", 1, .25)), "Китай поддерживает экономику — спрос на сырьё"),
    ("china_slow", (("кита", "china", "chinese"), ("замедл", "slow", "спад", "дефляц", "deflation")),
     (("china", -1, .5), ("oil", -1, .3)), "Китай замедляется — спрос на сырьё ниже"),
    ("gold_record", (("золот", "gold"), ("рекорд", "record", "all-time high", "исторически максимум")),
     (("gold", 1, .5),), "золото обновляет рекорды"),
]

# ---------- справочник мест: (основы через «|»; «=слово» — точное слово; несколько слов — фраза), имя, широта, долгота
PLACES_RAW = """
росси|российск|russia|russian|кремл|kremlin;Россия;55.75;37.62
москв|moscow;Москва;55.75;37.62
петербург|petersburg;Санкт-Петербург;59.94;30.31
украин|ukrain|киев|kyiv|kiev;Украина;50.45;30.52
харьков|kharkiv;Харьков;49.99;36.23
одесс|odesa|odessa;Одесса;46.48;30.72
крым|crimea;Крым;44.95;34.10
=сша|соединен штат|united states|=u =s|вашингтон|washington|бел дом|white house|пентагон|pentagon;США;38.90;-77.04
фрс|=fed|federal reserve|пауэлл|powell|байден|biden|трамп|trump;США;38.90;-77.04
нью-йорк|new york|уолл-стрит|wall street;Нью-Йорк;40.71;-74.01
калифорни|california|лос-анджелес|los angeles|кремниев долин|silicon valley;Калифорния;36.78;-119.42
техас|texas;Техас;31.0;-99.9
флорид|florida;Флорида;27.66;-81.52
канад|canada|canadian|оттав|ottawa;Канада;45.42;-75.70
мексик|mexico|mexican;Мексика;19.43;-99.13
кита|china|chinese|пекин|beijing|си цзиньпин|xi jinping;Китай;39.90;116.40
шанха|shanghai;Шанхай;31.23;121.47
гонконг|hong kong;Гонконг;22.32;114.17
тайван|taiwan|тайбэ|taipei|tsmc;Тайвань;25.03;121.57
япони|японск|japan|japanese|токио|tokyo;Япония;35.68;139.69
южн коре|south korea|сеул|seoul|samsung;Южная Корея;37.57;126.98
кндр|северн коре|north korea|пхеньян|pyongyang;КНДР;39.03;125.75
=индия|=индии|=индию|=индией|индийск|india|indian|нью-дели|=дели|delhi|моди|modi;Индия;28.61;77.21
пакистан|pakistan|исламабад|islamabad;Пакистан;33.68;73.05
афганистан|afghanistan|кабул|kabul|талибан|taliban;Афганистан;34.53;69.17
иран|iran|тегеран|tehran;Иран;35.69;51.39
ирак|iraq|багдад|baghdad;Ирак;33.31;44.36
сири|syria|дамаск|damascus;Сирия;33.51;36.29
ливан|lebanon|бейрут|beirut|хезболл|hezbollah;Ливан;33.89;35.50
израил|israel|тель-авив|tel aviv|иерусалим|jerusalem|нетаньяху|netanyahu;Израиль;31.77;35.21
сектор газ|gaza|палестин|palestin|хамас|hamas;Сектор Газа;31.50;34.47
иордан|jordan;Иордания;31.95;35.93
саудовск|saudi|эр-рияд|=рияд|riyadh|aramco;Саудовская Аравия;24.71;46.68
=оаэ|эмират|emirat|=uae|дуба|dubai|абу-даби|abu dhabi;ОАЭ;24.45;54.38
катар|qatar|доха|doha;Катар;25.29;51.53
йемен|yemen|хусит|houthi|сана|sanaa;Йемен;15.37;44.19
красн мор|red sea|баб-эль-мандеб|bab el-mandeb;Красное море;20.0;38.5
ормуз|hormuz;Ормузский пролив;26.57;56.25
персидск залив|persian gulf;Персидский залив;26.5;52.0
суэц|suez;Суэцкий канал;30.58;32.27
егип|egypt|каир|cairo;Египет;30.04;31.24
турци|турецк|turkey|turkish|türkiye|анкар|ankara|стамбул|istanbul|эрдоган|erdogan;Турция;39.93;32.86
=грузия|=грузии|=грузию|тбилис|tbilisi;Грузия;41.72;44.79
армени|armenia|ереван|yerevan;Армения;40.18;44.51
азербайджан|azerbaijan|=баку|baku;Азербайджан;40.41;49.87
казахстан|kazakhstan|астан|astana|алмат|almaty;Казахстан;51.17;71.43
узбекистан|uzbekistan|ташкент|tashkent;Узбекистан;41.30;69.24
белорус|беларус|belarus|минск|minsk|лукашенк|lukashenko;Беларусь;53.90;27.56
польш|польск|poland|polish|варшав|warsaw;Польша;52.23;21.01
германи|немецк|germany|german|берлин|berlin|бундестаг;Германия;52.52;13.40
франци|французск|france|french|париж|paris|макрон|macron;Франция;48.86;2.35
британи|британск|britain|british|англи|england|лондон|london|=uk;Великобритания;51.51;-0.13
ирланди|ireland|дублин|dublin;Ирландия;53.35;-6.26
итали|italy|italian|=рим|=риме|=рима|rome|милан|milan;Италия;41.90;12.50
испани|spain|spanish|мадрид|madrid|барселон|barcelona;Испания;40.42;-3.70
португали|portugal|лиссабон|lisbon;Португалия;38.72;-9.14
нидерланд|голланди|netherlands|dutch|амстердам|amsterdam|гааг|hague;Нидерланды;52.37;4.90
европ|europe;Европа;50.11;8.68
бельги|belgium|брюссел|brussels|евросоюз|=ес|=eu|european union;Евросоюз;50.85;4.35
еврокомисс|european commission|европарламент;Евросоюз;50.85;4.35
швейцари|switzerland|swiss|женев|geneva|цюрих|zurich|давос|davos;Швейцария;46.95;7.45
австри|austria|=вена|=вене|vienna;Австрия;48.21;16.37
опек|opec;ОПЕК · Вена;48.21;16.37
венгри|hungary|будапешт|budapest|орбан|orban;Венгрия;47.50;19.04
чехи|czech|=прага|=праге|prague;Чехия;50.08;14.44
румыни|romania|бухарест|bucharest;Румыния;44.43;26.10
серби|serbia|белград|belgrade;Сербия;44.79;20.45
молдави|молдов|moldova|кишин|chisinau;Молдова;47.01;28.86
греци|greece|greek|афин|athens;Греция;37.98;23.73
балти|baltic;Балтика;56.9;19.9
латви|latvia|рига|riga;Латвия;56.95;24.11
литв|lithuania|вильнюс|vilnius;Литва;54.69;25.28
эстони|estonia|таллин|tallinn;Эстония;59.44;24.75
финлянд|finland|хельсинк|helsinki;Финляндия;60.17;24.94
швеци|sweden|swedish|стокгольм|stockholm;Швеция;59.33;18.07
норвеги|norway|осло|oslo;Норвегия;59.91;10.75
=дания|=дании|=данию|denmark|копенгаген|copenhagen;Дания;55.68;12.57
гренланди|greenland;Гренландия;64.18;-51.72
исланди|iceland;Исландия;64.15;-21.94
арктик|arctic;Арктика;80.0;0.0
антарктид|antarctic;Антарктида;-77.85;166.67
бразили|brazil|brasilia|бразилиа|сан-паулу|sao paulo|лула|lula;Бразилия;-15.79;-47.88
аргентин|argentin|буэнос-айрес|buenos aires|милей|milei;Аргентина;-34.60;-58.38
=чили|chile|сантьяго|santiago;Чили;-33.45;-70.67
=перу|peru|=лима|=lima;Перу;-12.05;-77.04
колумби|colombia|богот|bogota;Колумбия;4.71;-74.07
венесуэл|venezuela|каракас|caracas|мадуро|maduro;Венесуэла;10.48;-66.90
эквадор|ecuador;Эквадор;-0.18;-78.47
боливи|bolivia;Боливия;-16.50;-68.15
=куба|=кубы|=кубе|=кубу|=cuba|гаван|havana;Куба;23.11;-82.37
гаити|haiti;Гаити;18.54;-72.34
панам|panama;Панама;8.98;-79.52
марокк|morocco|рабат|rabat;Марокко;34.02;-6.84
алжир|algeria;Алжир;36.75;3.06
тунис|tunisia;Тунис;36.81;10.18
=ливия|=ливии|=ливию|libya|триполи|tripoli;Ливия;32.89;13.19
судан|sudan|хартум|khartoum;Судан;15.50;32.56
эфиопи|ethiopia|аддис-абеб|addis ababa;Эфиопия;9.03;38.74
сомали|somalia|могадишо|mogadishu;Сомали;2.05;45.32
кени|kenya|найроби|nairobi;Кения;-1.29;36.82
нигери|nigeria|лагос|lagos|абудж|abuja;Нигерия;9.08;7.40
=нигер|=niger|ниамей|niamey;Нигер;13.51;2.11
=мали|=mali|бамако|bamako;Мали;12.64;-8.00
конго|congo|киншас|kinshasa;ДР Конго;-4.44;15.27
=юар|южн африк|south africa|йоханнесбург|johannesburg|кейптаун|cape town;ЮАР;-25.75;28.19
ангол|angola;Ангола;-8.84;13.23
мозамбик|mozambique;Мозамбик;-25.97;32.57
австрали|australia|сидне|sydney|канберр|canberra;Австралия;-35.28;149.13
нов зеланди|new zealand;Новая Зеландия;-41.29;174.78
индонези|indonesia|джакарт|jakarta|бали|bali;Индонезия;-6.21;106.85
филиппин|philippin|манил|manila;Филиппины;14.60;120.98
вьетнам|vietnam|ханой|hanoi;Вьетнам;21.03;105.85
таиланд|тайланд|thailand|бангкок|bangkok;Таиланд;13.76;100.50
малайзи|malaysia|куала-лумпур|kuala lumpur;Малайзия;3.14;101.69
сингапур|singapore;Сингапур;1.35;103.82
бангладеш|bangladesh|дакк|dhaka;Бангладеш;23.81;90.41
мьянм|myanmar|бирм|burma;Мьянма;19.76;96.08
непал|nepal;Непал;27.72;85.32
шри-ланк|sri lanka;Шри-Ланка;6.93;79.85
монголи|mongolia;Монголия;47.89;106.91
"""


def _parse_places() -> list[tuple[list[list[str]], str, float, float]]:
    out = []
    for line in PLACES_RAW.strip().splitlines():
        keys, name, lat, lon = line.split(";")
        out.append(([k.split() for k in keys.split("|")], name, float(lat), float(lon)))
    return out


PLACES = _parse_places()
WORD = re.compile(r"[a-zа-я0-9]+(?:-[a-zа-я0-9]+)*")


def words(text: str) -> list[str]:
    return WORD.findall(str(text or "").lower().replace("ё", "е"))


def _match_at(ws: list[str], i: int, key: list[str]) -> bool:
    if i + len(key) > len(ws):
        return False
    for j, k in enumerate(key):
        w = ws[i + j]
        if k.startswith("="):
            if w != k[1:]:
                return False
        elif not w.startswith(k):
            return False
    return True


def has(ws: list[str], stems: tuple[str, ...]) -> str | None:
    """Первая из основ (одно слово — начало слова, несколько — фраза подряд), найденная в тексте."""
    for stem in stems:
        key = stem.split()
        if any(_match_at(ws, i, key) for i in range(len(ws))):
            return stem
    return None


def locate(title: str, summary: str = "") -> dict | None:
    """Место новости: самое раннее упоминание в заголовке (потом — в тексте); фраза важнее слова."""
    for text in (title, summary):
        ws = words(text)
        best = None
        for keys, name, lat, lon in PLACES:
            for key in keys:
                for i in range(len(ws)):
                    if _match_at(ws, i, key):
                        score = (i, -len(key), -len("".join(key)))
                        if best is None or score < best[0]:
                            best = (score, name, lat, lon)
                        break
        if best:
            return {"name": best[1], "lat": best[2], "lon": best[3]}
    return None


def classify(ws: list[str]) -> str:
    for kind, stems in CATEGORY_WORDS:
        if has(ws, stems):
            return kind
    return "other"


def market_effects(ws: list[str]) -> list[dict]:
    """Правила «событие → рынок»; несколько правил про один рынок складываются (уверенность — не больше 0,9)."""
    acc: dict[str, dict] = {}
    for rule in MARKET_RULES:
        groups, effects, reason = rule[1], rule[2], rule[3]
        if not all(has(ws, g) for g in groups) or (len(rule) > 4 and has(ws, rule[4])):
            continue
        for market, direction, conf in effects:
            cur = acc.setdefault(market, {"market": market, "score": 0.0, "reasons": []})
            cur["score"] += direction * conf
            if reason not in cur["reasons"]:
                cur["reasons"].append(reason)
    out = []
    for m in acc.values():
        if abs(m["score"]) < .1:
            continue
        out.append({"market": m["market"], "name": MARKETS[m["market"]]["name"], "dir": 1 if m["score"] > 0 else -1,
                    "conf": round(min(.9, abs(m["score"])), 2), "reason": "; ".join(m["reasons"])})
    return sorted(out, key=lambda m: -m["conf"])


def forecast_phrase(text: str) -> str | None:
    m = FORECAST.search(text or "")
    return m.group(0) if m else None


def severity(kind: str, ws: list[str], markets: list[dict], magnitude: float | None = None) -> float:
    s = BASE_SEVERITY.get(kind, .2)
    if magnitude is not None:
        s = max(.2, min(1.0, (magnitude - 4) / 3.5))
    if has(ws, ("погиб", "жертв", "убит", "killed", "dead", "deaths", "casualt")):
        s += .15
    if any(w.isdigit() and int(w) >= 100 and not 1900 <= int(w) <= 2100 for w in ws if len(w) < 7):
        s += .05
    if has(ws, ("крупнейш", "рекорд", "масштабн", "беспрецедент", "massive", "largest", "record", "major")):
        s += .1
    if markets:
        s += .05 + .1 * max(m["conf"] for m in markets)
    return round(min(1.0, s), 2)


def analyze(raw: dict) -> dict:
    """Новость → маркер: место, вид, важность, рынки, прогноз, экономический ли маркер."""
    title, summary = raw.get("title", ""), raw.get("summary", "")
    text = f"{title}. {summary}"
    ws = words(text)
    kind = raw.get("kind") or classify(words(title))
    if kind == "other":
        kind = classify(ws)
    markets = raw.get("markets") if raw.get("markets") is not None else market_effects(ws)
    fc = forecast_phrase(title) or forecast_phrase(summary)
    place = raw.get("place") or locate(title, summary)
    item = {**raw, "kind": kind, "kind_label": KINDS.get(kind, kind), "place": place, "markets": markets,
            "forecast": fc, "economic": bool(fc and markets),
            "severity": severity(kind, ws, markets, raw.get("magnitude"))}
    item["marker"] = "economic" if item["economic"] else kind
    return item


# ---------- ленты ----------
TAG = re.compile(r"<[^>]+>")


def clean(text: str, limit: int = 400) -> str:
    t = html.unescape(TAG.sub(" ", html.unescape(str(text or ""))))
    t = re.sub(r"\s+", " ", t).strip()
    return t[:limit] + ("…" if len(t) > limit else "")


def _ts(value: str | None) -> float | None:
    if not value:
        return None
    value = value.strip()
    try:
        return parsedate_to_datetime(value).timestamp()
    except (TypeError, ValueError, IndexError):
        pass
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def item_id(link: str, title: str) -> str:
    return hashlib.sha1((link or title).strip().encode()).hexdigest()[:12]


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def parse_feed(data: bytes | str, url: str = "", now: float | None = None) -> list[dict]:
    """RSS 2.0 / Atom → [{id, title, summary, link, source, ts}]."""
    if isinstance(data, str):
        data = data.encode()
    if len(data) > MAX_BYTES:
        raise ValueError("лента слишком большая")
    root = ET.fromstring(data)
    source = ""
    for el in root.iter():
        if _local(el.tag) == "title" and (el.text or "").strip():
            source = clean(el.text, 60)
            break
    if not source:
        source = re.sub(r"^https?://(www\.)?", "", url).split("/")[0]
    out = []
    for el in root.iter():
        if _local(el.tag) not in ("item", "entry"):
            continue
        f: dict[str, str] = {}
        for ch in el:
            name = _local(ch.tag)
            if name == "link":
                f.setdefault("link", (ch.get("href") or ch.text or "").strip())
            elif name in ("title", "description", "summary", "content", "pubdate", "published", "updated", "date"):
                f.setdefault(name, ch.text or "")
        title = clean(f.get("title"), 220)
        if not title:
            continue
        link = f.get("link", "")
        ts = _ts(f.get("pubdate") or f.get("published") or f.get("updated") or f.get("date")) or now or time.time()
        out.append({"id": item_id(link, title), "title": title,
                    "summary": clean(f.get("description") or f.get("summary") or f.get("content") or ""),
                    "link": link if link.startswith(("https://", "http://")) else "", "source": source, "ts": ts})
    return out


def parse_quakes(data: dict) -> list[dict]:
    """USGS GeoJSON → новости-землетрясения (место — координаты эпицентра)."""
    out = []
    for f in (data or {}).get("features", [])[:80]:
        p, g = f.get("properties") or {}, (f.get("geometry") or {}).get("coordinates") or []
        if len(g) < 2 or p.get("mag") is None:
            continue
        mag = float(p["mag"])
        where = str(p.get("place") or "")
        title = f"Землетрясение M{mag:.1f}{' — ' + where if where else ''}"
        ws = words(where)
        markets = []
        if mag >= 6.3 and has(ws, ("taiwan", "japan")):
            markets = [{"market": "chips", "name": MARKETS["chips"]["name"], "dir": -1, "conf": .45,
                        "reason": "сильное землетрясение рядом с заводами чипов"}]
        out.append({"id": "q" + str(f.get("id") or item_id(str(p.get("url")), title))[:14], "title": title,
                    "summary": f"Глубина {round(g[2]) if len(g) > 2 and g[2] is not None else '?'} км. "
                               f"{'Предупреждение о цунами. ' if p.get('tsunami') else ''}Данные USGS.",
                    "link": str(p.get("url") or ""), "source": "USGS", "ts": (p.get("time") or 0) / 1000,
                    "kind": "quake", "magnitude": mag, "markets": markets,
                    "place": {"name": where or "эпицентр", "lat": float(g[1]), "lon": float(g[0])}})
    return out


# ---------- тактика ----------
def decay(age_h: float) -> float:
    """Вес сигнала по возрасту: половина — через 12 часов, через 48 — почти ноль."""
    return 0.5 ** (max(0.0, age_h) / 12)


def pressure(items: list[dict], now: float) -> dict[str, dict]:
    """Давление на рынки: −1…1 (tanh суммы направлений × уверенность × важность × свежесть) и главные причины."""
    acc: dict[str, dict] = {k: {"market": k, "name": v["name"], "raw": 0.0, "drivers": []} for k, v in MARKETS.items()}
    for it in items:
        age = (now - it.get("ts", now)) / 3600
        if age > FRESH_HOURS:
            continue
        w = decay(age) * (0.6 + 0.4 * it.get("severity", .3)) * (1.25 if it.get("forecast") else 1.0)
        for m in it.get("markets") or []:
            v = m["dir"] * m["conf"] * w
            a = acc[m["market"]]
            a["raw"] += v
            a["drivers"].append({"id": it["id"], "title": it["title"], "dir": m["dir"], "weight": round(abs(v), 3)})
    out = {}
    for k, a in acc.items():
        p = math.tanh(a["raw"] * 0.9)          # одна сильная новость — «давление», сильное — нужны несколько
        a["drivers"].sort(key=lambda d: -d["weight"])
        out[k] = {"market": k, "name": a["name"], "pressure": round(p, 2), "signals": len(a["drivers"]),
                  "label": pressure_label(p), "drivers": a["drivers"][:3]}
    return out


def pressure_label(p: float) -> str:
    if p >= .55:
        return "сильное давление вверх"
    if p >= .2:
        return "давление вверх"
    if p <= -.55:
        return "сильное давление вниз"
    if p <= -.2:
        return "давление вниз"
    return "нейтрально"


OIL_GAS = {"LKOH", "ROSN", "TATN", "SNGS", "SNGSP", "SIBN", "BANE", "TRNFP"}
GAS = {"GAZP", "NVTK"}
GOLD = {"PLZL", "UGLD", "SELG", "GLDRUB", "PAXG", "XAUT", "TGLD", "GOLD"}


def exposure(asset: dict) -> list[tuple[str, int]]:
    """Какие рынки двигают актив: [(рынок, знак)] — знак −1, если актив растёт, когда рынок падает."""
    kind, t = asset.get("kind"), str(asset.get("ticker") or "").upper()
    name = str(asset.get("name") or "").lower()
    if t in GOLD or "золот" in name or "gold" in name:
        return [("gold", 1)]
    if kind == "crypto":
        return [("crypto", 1)]
    if kind == "fx":
        return [("rub", -1)]                          # валюта дорожает, когда рубль слабеет
    if kind in ("stock", "fund"):
        if t in OIL_GAS:
            return [("oil", 1), ("moex", 1)]
        if t in GAS:
            return [("gas", 1), ("moex", 1)]
        return [("moex", 1)]
    if kind == "bond":
        return [("rates", -1)]
    return []


def tactics(items: list[dict], assets: list[dict], now: float) -> dict:
    """Тактика: давление на рынки, что это значит для портфеля, идеи-сценарии. Не инвестиционная рекомендация."""
    pr = pressure(items, now)
    positions = []
    for a in assets:
        exp = exposure(a)
        if not exp:
            continue
        score = sum(sign * pr[m]["pressure"] for m, sign in exp) / len(exp)
        drivers = [d for m, _ in exp for d in pr[m]["drivers"]][:2]
        stance = ("попутный ветер" if score >= .2 else "встречный ветер" if score <= -.2 else "без сильных сигналов")
        positions.append({"name": a.get("name"), "ticker": a.get("ticker") or "", "kind": a.get("kind"),
                          "markets": [MARKETS[m]["name"] for m, _ in exp], "score": round(score, 2),
                          "stance": stance, "drivers": drivers})
    positions.sort(key=lambda p: p["score"])
    ideas = []
    for k, p in sorted(pr.items(), key=lambda kv: -abs(kv[1]["pressure"])):
        v = p["pressure"]
        if abs(v) < .2 or not p["drivers"]:
            continue
        mine = [x for x in positions if MARKETS[k]["name"] in x["markets"]]
        if v > 0:
            action = "держать / не спешить продавать" if mine else "наблюдать за точкой входа"
        else:
            action = "проверить размер позиции и стоп" if mine else "не открывать позицию против потока"
        ideas.append({"market": k, "name": p["name"], "pressure": v, "label": p["label"], "action": action,
                      "confidence": round(min(.9, abs(v)), 2), "why": p["drivers"][0]["title"],
                      "yours": [x["ticker"] or x["name"] for x in mine]})
    return {"markets": list(pr.values()), "positions": positions, "ideas": ideas[:6],
            "disclaimer": "Сигналы по заголовкам новостей — сценарии для размышления, не инвестиционная рекомендация."}


# ---------- стол новостей ----------
FetchBytes = Callable[[str], Awaitable[bytes]]


class NewsDesk:
    """Опрашивает ленты, разбирает новости, хранит последние MAX_ITEMS в data/news.json."""

    def __init__(self, data_dir: Path, feeds: list[str] | None = None, fetch: FetchBytes | None = None,
                 quakes: bool = True):
        self.path = Path(data_dir) / "news.json"
        self.feeds = list(feeds or DEFAULT_FEEDS)
        self.quakes = quakes
        self._fetch = fetch
        self._session: Any = None
        self.items: dict[str, dict] = {}
        self.status: dict[str, dict] = {}
        self.updated: float | None = None
        self.lock = asyncio.Lock()
        self._load()

    def _load(self) -> None:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            self.items = {i["id"]: i for i in data.get("items", [])}
            self.updated = data.get("updated")
        except (OSError, ValueError, KeyError, TypeError):
            self.items = {}

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"updated": self.updated, "items": self.list()}, ensure_ascii=False),
                       encoding="utf-8")
        tmp.replace(self.path)

    async def fetch(self, url: str) -> bytes:
        if self._fetch:
            return await self._fetch(url)
        import aiohttp
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=12), trust_env=True,
                                                  headers={"User-Agent": "atom-news/1.0"})
        async with self._session.get(url) as r:
            r.raise_for_status()
            data = await r.content.read(MAX_BYTES + 1)
            return data

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def _one(self, url: str, now: float) -> list[dict]:
        t0 = time.monotonic()
        try:
            data = await self.fetch(url)
            if url == QUAKES:
                found = parse_quakes(json.loads(data))
            else:
                found = parse_feed(data, url, now)
            self.status[url] = {"ok": True, "count": len(found), "ms": round((time.monotonic() - t0) * 1000),
                                "at": now}
            return found
        except Exception as e:  # noqa: BLE001 — одна лента не должна ронять остальные
            self.status[url] = {"ok": False, "error": str(e)[:160] or type(e).__name__, "at": now}
            log.info("лента %s: %s", url, e)
            return []

    async def poll(self, now: float | None = None) -> list[dict]:
        """Опросить все источники; вернуть новые (разобранные) новости, от свежих к старым."""
        now = now or time.time()
        async with self.lock:
            urls = [*self.feeds, *([QUAKES] if self.quakes else [])]
            batches = await asyncio.gather(*(self._one(u, now) for u in urls))
            fresh = []
            for raw in (r for b in batches for r in b):
                if raw["id"] in self.items or now - raw["ts"] > FRESH_HOURS * 3600:
                    continue
                item = analyze(raw)
                item["seen"] = now
                self.items[item["id"]] = item
                fresh.append(item)
            if len(self.items) > MAX_ITEMS:
                for old in sorted(self.items.values(), key=lambda i: i["ts"])[:len(self.items) - MAX_ITEMS]:
                    self.items.pop(old["id"], None)
            self.updated = now
            self._save()
            return sorted(fresh, key=lambda i: -i["ts"])

    def list(self, since: float = 0) -> list[dict]:
        return sorted((i for i in self.items.values() if i.get("seen", i["ts"]) > since), key=lambda i: -i["ts"])

    def get(self, item_id: str) -> dict | None:
        return self.items.get(item_id)

    def sources(self) -> list[dict]:
        urls = [*self.feeds, *([QUAKES] if self.quakes else [])]
        return [{"url": u, **self.status.get(u, {"ok": None})} for u in urls]


def signal_line(item: dict, when: datetime) -> str:
    """Строка в Jarvis/News/Сигналы.md: | когда | рынок | прогноз | уверенность | источник |"""
    def cell(s: str) -> str:
        return str(s).replace("|", "/").replace("\n", " ").strip()
    mk = ", ".join(f"{m['name']} {'↑' if m['dir'] > 0 else '↓'}" for m in item["markets"])
    conf = max(m["conf"] for m in item["markets"])
    src = f"[{cell(item['source'])}]({item['link']})" if item.get("link") else cell(item.get("source", ""))
    where = f" ({cell(item['place']['name'])})" if item.get("place") else ""
    return f"| {when.strftime('%Y-%m-%d %H:%M')} | {mk} | {cell(item['title'])}{where} | {round(conf * 100)}% | {src} |"


SIGNALS_HEADER = ("---\ntype: signals\n---\n# Экономические сигналы\n\n"
                  "Atom пишет сюда новости с явным прогнозом, который влияет на рынок (приложение «Глобус»). "
                  "Это сигналы по заголовкам, не инвестиционная рекомендация.\n\n"
                  "| Когда | Рынок | Прогноз | Уверенность | Источник |\n|---|---|---|---|---|\n")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)
