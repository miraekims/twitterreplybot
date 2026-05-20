# X Premium: Требования и оптимизация

## Почему X Premium обязателен

Данные Buffer (анализ 18.8M постов, 2026):
- **Free аккаунты**: среднее 0 impressions на пост (половина получает буквально ноль)
- **Premium ($8/мес)**: ~600 impressions/пост
- **Premium+ ($16/мес)**: ~1,550 impressions/пост

Это **10x разница в reach** просто от подписки. Без Premium бот работает вхолостую — посты никто не видит.

## Что даёт Premium для бота

| Фича | Эффект на бота |
|------|---------------|
| Verified badge (синяя галочка) | Replies не прячутся в "Show more replies" |
| Prioritized ranking | Посты попадают в "For You" чужих лент |
| Edit tweet | Можно исправить опечатку AI без удаления |
| Long posts (до 25k chars) | Не нужно для нас (280 max по стратегии) |
| Revenue sharing | Заработок с impressions >5M/мес |
| Reduced ads | Не критично для бота |

## Критичное: verified replies видны ВСЕМ

X скрывает replies от unverified аккаунтов в "probable spam" и "Show additional replies". С Premium:
- Твои ответы видны сразу в основном треде
- Не попадают под фильтр "probable spam"
- Получают приоритет в сортировке (verified replies показываются выше)

**Без Premium все reply бота работают на 10-20% эффективности.**

## Как подключить

1. Зайди на https://x.com/i/premium_sign_up
2. Выбери **Premium** ($8/мес) — Premium+ не нужен для наших целей
3. Оплати (карта или крипто через https://premium.twitter.com/)
4. Галочка появится через 24-48ч (верификация)

## Оптимизация для verified аккаунта

### Что бот уже делает правильно:
- ✅ Reply на комментаторов (не на авторов) — меньше жалоб
- ✅ Substantive replies 80-150 chars с конкретикой — не выглядят как спам
- ✅ Auto-posts 3-6/день — здоровый ratio originals:replies
- ✅ Per-author cooldown 24h — не бомбит одного человека
- ✅ Auto-reply на свои посты — x150 boost от алгоритма

### Дополнительные оптимизации для verified:

#### 1. Engagement velocity (первые 30 мин)
Verified посты получают больше начального распространения. Бот должен:
- Постить в **peak hours** (9-11 AM и 5-7 PM по таймзоне аудитории)
- Сразу после публикации своего поста — ответить на 2-3 комментария из ленты чтобы оставаться "active" в глазах алго

#### 2. Reply quality signals
С verified badge алгоритм БОЛЬШЕ смотрит на качество:
- Уникальность текста (AI rewrite уже это делает)
- Длина > 50 chars (короткие "gm" от verified выглядят подозрительно)
- Отсутствие ссылок в первых 3 reply (X душит link-spam от verified)

#### 3. Verified follower ratio
X смотрит на % verified подписчиков. Стратегия:
- Реплаить на других verified пользователей (они с большей вероятностью подпишутся)
- Не гнаться за quantity follows — лучше 1000 verified чем 10000 обычных

## Настройки бота для Premium аккаунта

В `/settings` (Telegram) рекомендуется:
```
Pacing: medium (30/h) — verified может больше, но safe лучше для первых 2 недель
Author cooldown: 24h
skipReplies: OFF — можно отвечать на replies (verified не прячется)
minAuthorFollowers: 1000 — целиться выше, отсеивать ботов
```

После 2 недель без 401/403/429 в логах:
```
Pacing: highvolume (50/h)
```

## Метрики для отслеживания

В Telegram `/stats`:
- **Impressions/post** (нужен X Analytics → developer.x.com)
- **Engagement rate**: цель 3-5%
- **Follower growth**: цель 50-200/день при активном боте
- **Reply visibility**: проверяй вручную — твои replies видны без "Show more"?

## Timeline

| Неделя | Действие |
|--------|----------|
| 0 | Купить Premium, запустить бота на safe preset |
| 1 | Убедиться что replies видны, нет spam-флагов |
| 2 | Переключить на medium (30/h), включить auto-draft |
| 3 | Если чисто — highvolume (50/h), 6 постов/день |
| 4+ | Мониторить ER, тюнить персону под аудиторию |

## Стоимость

- X Premium: $8/мес
- OpenAI API (gpt-4o-mini): ~$3-5/мес при 1000 replies/день + 6 posts
- **Итого: ~$13/мес** за полностью автоматический рост

---

*Этот документ — часть стратегии engagement growth. См. bot/ROADMAP.md для общего плана развития.*
