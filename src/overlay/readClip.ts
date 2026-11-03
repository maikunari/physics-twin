/** What the page reads from a picked clip before sending it to the thin server. */
export interface ClipFrame {
  readonly durationSec: number;
  /** Displayed size, after the file's rotation: what Muse Spark and SAM see. */
  readonly width: number;
  readonly height: number;
  /** Frame 0 as a JPEG data URL. */
  readonly frame0: string;
}

/** Loads the clip in a hidden video element and draws its first frame. Browser only. */
export async function readClip(file: File): Promise<ClipFrame> {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('this browser cannot decode the clip'));
      video.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2D canvas to draw frame 0 on');
    ctx.drawImage(video, 0, 0);
    return { durationSec: video.duration, width: video.videoWidth, height: video.videoHeight, frame0: canvas.toDataURL('image/jpeg', 0.92) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('could not read the clip'));
    reader.readAsDataURL(file);
  });
}
