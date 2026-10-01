import { FlameIcon } from "../icons";
import styles from "./IntroScreen.module.scss";

interface IntroScreenProps {
  leaving: boolean;
  onStart: () => void;
}

/** First screen: the name of the app and a single button to light the fire. */
export function IntroScreen({ leaving, onStart }: IntroScreenProps) {
  return (
    <section className={styles.intro} data-leaving={leaving || undefined} aria-hidden={leaving || undefined}>
      <div className={styles.content}>
        <h1 className={styles.title}>Fireplace</h1>
        <button type="button" className={styles.start} onClick={onStart} disabled={leaving} autoFocus>
          <FlameIcon className={styles.flame} />
          <span>Light the fireplace</span>
        </button>
      </div>
      <p className={styles.hint}>Better with sound</p>
    </section>
  );
}
