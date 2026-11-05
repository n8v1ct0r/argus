import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono } from "next/font/google";
import { HonestyStrip } from "../components/HonestyStrip.tsx";
import "./globals.css";

// The console uses the platform's own UI and mono faces (SF on Apple devices); no web font to
// download before the text paints.
// The shared honesty strip's face (one visual signature across Nate's sidequests).
const stripMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Argus",
  description:
    "A real-time view of Earth plus an AI analyst whose every sentence links to the raw events behind it.",
};

export const viewport: Viewport = {
  themeColor: "#050607",
  colorScheme: "dark",
};

// Direction contract. It survives the production build as markup.
const CONTRACT = `<!--
THESIS: Time and provenance are the interface. Argus is an operations console for checking an analyst: every sentence opens the stored events behind it.
OWN-WORLD: Dark glass over a monochrome point cloud Earth. Translucent night panels with blur and saturation, a 1px top highlight, soft offset shadows. One accent (orange) marks selection, citations, findings, and alerts. Platform UI face for text, platform mono for data.
STORY: The visitor reads the alert feed, opens a sentence, watches the globe fly to and ping its events, and checks every number against the stored record.
FIRST VIEWPORT: Globe as hero behind glass; top bar, left rail with layers, bottom row of inspector, counts, and the brief feed; the replay record along the bottom.
-->`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={stripMono.variable}>
      <body>
        <template id="direction-contract" dangerouslySetInnerHTML={{ __html: CONTRACT }} />
        <HonestyStrip />
        <div className="argus-below-strip">{children}</div>
      </body>
    </html>
  );
}
