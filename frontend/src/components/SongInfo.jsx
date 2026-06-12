export default function SongInfo({ title, artist, album }) {
  const textShadow =
    "0 1px 2px rgba(0,0,0,0.85), 0 2px 16px rgba(0,0,0,0.55)";

  return (
    <div className="text-center md:text-left px-6 md:px-0 pt-3 pb-3">
      <div
        className="text-[10px] uppercase tracking-widest2 text-bone/60 mb-2"
        style={{ textShadow }}
      >
        Now Playing
      </div>
      <div
        className="font-display text-[28px] md:text-[38px] leading-tight font-medium text-bone"
        style={{ textShadow }}
      >
        {title}
      </div>
      <div
        className="mt-1 text-[14px] md:text-[15px] text-bone/80 tracking-wide"
        style={{ textShadow }}
      >
        {artist}
        {album && (
          <span className="text-bone/55"> &nbsp;·&nbsp; {album}</span>
        )}
      </div>
    </div>
  );
}
