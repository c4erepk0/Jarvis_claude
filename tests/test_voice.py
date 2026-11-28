"""Голос Atom: бесплатные движки, подготовка текста, выбор голоса и кэш."""


from jarvis.voice import DEFAULT_VOICE, VOICES, Voice, speakable


def test_speakable_strips_markup():
    assert speakable("**Привет** `код` [ссылка](https://x)") == "Привет код ссылка"
    assert speakable("Цена 300₽ и 5% − итог") == "Цена 300 рублей и 5 процентов минус итог"
    assert speakable("😀 Текст") == "Текст"
    assert speakable("# Заголовок\n- пункт") == "Заголовок пункт"


def test_long_text_is_cut_at_sentence_not_mid_word():
    text = ("Первое предложение. " * 80).strip()
    out = speakable(text, limit=100)
    assert len(out) <= 100 and out.endswith(".")               # не обрывается на полуслове
    assert not out.endswith("предложени")

    # если точек нет вовсе — режем по последнему пробелу
    solid = "слово " * 60
    cut = speakable(solid, limit=40)
    assert len(cut) <= 40 and not cut.endswith(" ")
    assert cut.split(" ")[-1] == "слово"


def test_voice_list_is_free_and_real():
    assert [v for v, _ in VOICES] == ["ru-RU-DmitryNeural", "ru-RU-SvetlanaNeural"]
    assert DEFAULT_VOICE == "ru-RU-DmitryNeural"


def test_browser_has_no_server_voice(tmp_path):
    v = Voice("browser", "ru-RU-DmitryNeural", "+0%", "+0Hz", tmp_path)
    assert v.server_side is False
    assert __import__("asyncio").run(v.synthesize("Привет")) is None


def test_empty_voice_falls_back_to_default(tmp_path):
    v = Voice("edge", "", "+0%", "+0Hz", tmp_path)
    assert v.voice == DEFAULT_VOICE
    assert v.pick_voice("Привет") == DEFAULT_VOICE


def test_edge_keeps_russian_voice(tmp_path):
    v = Voice("edge", "en-GB-RyanNeural", "+0%", "+0Hz", tmp_path)
    assert v.pick_voice("Привет") == DEFAULT_VOICE                # кириллица → русский голос
    assert v.pick_voice("Hello") == "en-GB-RyanNeural"
    ru = Voice("edge", "ru-RU-SvetlanaNeural", "+0%", "+0Hz", tmp_path)
    assert ru.pick_voice("Привет") == "ru-RU-SvetlanaNeural"


def test_piper_without_model_is_not_an_error(tmp_path):
    v = Voice("piper", "ru-RU-DmitryNeural", "+0%", "+0Hz", tmp_path, piper_model="")
    assert v.server_side is True
    assert __import__("asyncio").run(v.synthesize("Привет")) is None   # нет модели → дашборд озвучит сам
    assert list(tmp_path.glob("*.wav")) == []


def test_cache_key_changes_with_voice_and_rate(tmp_path):
    v1 = Voice("edge", "ru-RU-DmitryNeural", "+0%", "+0Hz", tmp_path)
    v2 = Voice("edge", "ru-RU-SvetlanaNeural", "+0%", "+0Hz", tmp_path)
    v3 = Voice("edge", "ru-RU-DmitryNeural", "-6%", "+0Hz", tmp_path)
    keys = {v.engine + v.voice + v.rate + v.pitch for v in (v1, v2, v3)}
    assert len(keys) == 3


def test_muted_voice_is_silent(tmp_path):
    v = Voice("edge", "ru-RU-DmitryNeural", "+0%", "+0Hz", tmp_path)
    v.muted = True
    assert v.server_side is False
    assert __import__("asyncio").run(v.synthesize("Привет")) is None
