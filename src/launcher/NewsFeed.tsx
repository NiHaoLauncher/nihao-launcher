import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { open } from "@tauri-apps/api/shell";
import { t } from "@shared";
import NewsIcon from "@shared/assets/icons/news.svg?react";
import NIHAO_ICON from "@shared/assets/nihao-icon.png";
import { getGameConfig } from "../games/GameRegistry";

/** One news card. Modules return a list of these from their optional `get_news` method. */
export interface NewsItem {
  id: string;
  title: string;
  text?: string;
  /** Unix seconds; cards are sorted newest first, undated ones last. */
  date?: number;
  link?: string;
  /** A picture for the card's background (absolute URL or data URI); the source's icon, blurred, when absent. */
  image?: string;
}

interface Card extends NewsItem {
  source: string;
  icon?: string;
}


async function moduleNews(id: string): Promise<Card[]> {
  const items = await invoke("call_module", { module: id, method: "get_news", args: {} }).catch(() => null);
  if (!Array.isArray(items)) return [];
  const cfg = await getGameConfig(id).catch(() => null);
  return items.map((n: NewsItem) => ({ ...n, id: `${id}:${n.id}`, source: cfg?.name ?? id, icon: cfg?.icon }));
}

/** The launcher's own news (its latest release) plus whatever each game module publishes. */
export function NewsFeed() {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const modules = (await invoke("list_modules").catch(() => [])) as string[];
      const release: any = await invoke("get_latest_release", {}).catch(() => null);
      const own: Card[] = release
        ? [{
            id: `launcher:${release.version}`,
            title: `${t("update.title_whats_new", "What's new")} — ${release.version}`,
            text: release.description,
            source: "NiHao Launcher",
            icon: NIHAO_ICON,
          }]
        : [];
      const all = [...own, ...(await Promise.all(modules.map(moduleNews))).flat()];
      all.sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
      if (!cancelled) setCards(all);
    })();
    return () => { cancelled = true; };
  }, []);

  if (cards === null) return null;
  const card = cards[index % Math.max(cards.length, 1)];
  return (
    <section className="news">
      <h3 className="news-title"><NewsIcon width={20} height={20} /> {t("home.news", "News")}</h3>
      {!card ? <p className="news-empty">{t("home.news_empty", "No news yet")}</p> : (
        <div className={`news-body${paused ? " paused" : ""}`} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
          <div className="news-feature">
            {(card.image ?? card.icon) && <img key={card.id} className={`news-feature-bg${card.image ? " photo" : ""}`} src={card.image ?? card.icon} alt="" />}
            <div className="news-feature-body">
              <span className="news-kicker">
                {card.icon && <img src={card.icon} alt="" />}
                {card.source}{card.date && ` · ${new Date(card.date * 1000).toLocaleDateString()}`}
              </span>
              <h2>{card.title}</h2>
              {card.text && <p>{card.text}</p>}
              {card.link && <button type="button" className="news-link" onClick={() => open(card.link!)}>{t("home.news_more", "Read more")}</button>}
            </div>
          </div>
          <div className="news-items">
            {cards.map((c, i) => (
              <button type="button" key={c.id} className={`news-item${i === index ? " active" : ""}`} onClick={() => setIndex(i)}>
                {i === index && cards.length > 1 && <i className="news-fill" onAnimationEnd={() => setIndex((n) => (n + 1) % cards.length)} />}
                {c.icon && <img src={c.icon} alt="" />}
                <span>{c.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
