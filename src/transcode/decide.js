// Decision de lecture, sur le modele de Jellyfin et de Polyfin : l'app envoie dans PlaybackInfo
// son profil (DeviceProfile) qui dit ce qu'elle lit telle quelle (DirectPlayProfiles), ce qu'elle
// accepte converti (TranscodingProfiles) et ses limites (CodecProfiles, debit maximal). On compare
// avec les pistes de la version : lecture directe, ou diffusion HLS ou la video et le son sont
// copies quand l'app les lit, et convertis sinon.
// Une app qui n'envoie pas de profil (la plupart des apps TV) lit tout en direct, comme avant.

/** Liste "a,b,c" d'un profil, en minuscules ; vide = tout. */
function list(v) {
  return String(v || '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

// Noms de conteneurs equivalents (Jellyfin ecrit "mkv", "matroska" ou "webm").
const CONTAINER_ALIASES = { mkv: ['mkv', 'matroska'], webm: ['webm', 'mkv', 'matroska'], mp4: ['mp4', 'm4v', 'mov'], ts: ['ts', 'mpegts', 'm2ts'], avi: ['avi'] };
// Noms de codecs equivalents.
const CODEC_ALIASES = { h264: ['h264', 'avc'], hevc: ['hevc', 'h265'], av1: ['av1'], vp9: ['vp9'], eac3: ['eac3', 'ec-3'], ac3: ['ac3', 'ac-3'], dts: ['dts', 'dca'], truehd: ['truehd'], aac: ['aac'], mp3: ['mp3'], opus: ['opus'], flac: ['flac'], vorbis: ['vorbis'] };

function containerOk(allowed, container) {
  if (!allowed.length) return true;
  const names = CONTAINER_ALIASES[container] || [container];
  return names.some((n) => allowed.includes(n));
}

function codecOk(allowed, codec) {
  if (!allowed.length) return true;
  if (!codec) return true;
  const names = CODEC_ALIASES[codec] || [codec];
  return names.some((n) => allowed.includes(n));
}

/** Valeur d'une propriete de condition (CodecProfiles) pour une piste ; undefined si inconnue. */
function propertyOf(stream, property) {
  switch (property) {
    case 'VideoRangeType':
      return stream.VideoRangeType;
    case 'VideoRange':
      return stream.VideoRange;
    case 'VideoBitDepth':
      return stream.BitDepth;
    case 'Width':
      return stream.Width;
    case 'Height':
      return stream.Height;
    case 'VideoProfile':
      return stream.Profile ? String(stream.Profile).toLowerCase() : undefined;
    case 'VideoLevel':
      return stream.Level || undefined;
    case 'AudioChannels':
      return stream.Channels;
    case 'IsInterlaced':
      return stream.IsInterlaced;
    default:
      return undefined;
  }
}

/** Une condition est-elle remplie ? Une valeur inconnue la remplit, sauf IsRequired. */
function conditionOk(stream, c) {
  const value = propertyOf(stream, c.Property);
  if (value === undefined || value === null || value === '') return !c.IsRequired;
  const want = String(c.Value ?? '');
  const num = Number(value);
  switch (c.Condition) {
    case 'Equals':
      return String(value).toLowerCase() === want.toLowerCase();
    case 'NotEquals':
      return String(value).toLowerCase() !== want.toLowerCase();
    case 'EqualsAny':
      return list(want.replace(/\|/g, ',')).includes(String(value).toLowerCase());
    case 'LessThanEqual':
      return Number.isFinite(num) ? num <= Number(want) : true;
    case 'GreaterThanEqual':
      return Number.isFinite(num) ? num >= Number(want) : true;
    default:
      return true;
  }
}

/** Conditions des CodecProfiles qui s'appliquent a une piste (type et codec), toutes remplies ? */
function codecProfilesOk(profile, stream, type) {
  for (const cp of profile.CodecProfiles || []) {
    if (String(cp.Type || '').toLowerCase() !== type) continue;
    const codecs = list(cp.Codec);
    if (codecs.length && !codecOk(codecs, stream.Codec)) continue;
    if (cp.ApplyConditions?.length && !cp.ApplyConditions.every((c) => conditionOk(stream, c))) continue;
    if (!(cp.Conditions || []).every((c) => conditionOk(stream, c))) return false;
  }
  return true;
}

/**
 * Decision pour une version : streams (MediaStreams Jellyfin), container, bitrate (bit/s, 0 si
 * inconnu), audioIndex (piste audio choisie, Index), et la requete PlaybackInfo (DeviceProfile,
 * MaxStreamingBitrate, EnableDirectPlay, AllowVideoStreamCopy...).
 * Renvoie { directPlay, reasons, transcoding: { container, protocol, videoCodec, audioCodec,
 * maxAudioChannels } | null, copyVideo, copyAudio }.
 */
function decide({ streams, container, bitrate = 0, audioIndex, request = {} }) {
  const profile = request.DeviceProfile;
  const video = streams.find((s) => s.Type === 'Video');
  const audio = streams.find((s) => s.Type === 'Audio' && s.Index === audioIndex) || streams.find((s) => s.Type === 'Audio' && s.IsDefault) || streams.find((s) => s.Type === 'Audio');
  if (!profile) return { directPlay: true, reasons: [], transcoding: null, copyVideo: true, copyAudio: true };

  const maxBitrate = Number(request.MaxStreamingBitrate) || Number(profile.MaxStreamingBitrate) || 0;
  const reasons = new Set();
  const videoOk = !video || codecProfilesOk(profile, video, 'video');
  const audioOk = !audio || codecProfilesOk(profile, audio, 'videoaudio');
  if (!videoOk) reasons.add(video?.VideoRangeType && video.VideoRangeType !== 'SDR' ? 'VideoRangeTypeNotSupported' : 'VideoProfileNotSupported');
  if (!audioOk) reasons.add('AudioChannelsNotSupported');
  if (maxBitrate && bitrate && bitrate > maxBitrate) reasons.add('ContainerBitrateExceedsLimit');

  // Lecture directe : un DirectPlayProfile video qui accepte le conteneur et les codecs.
  const direct = (profile.DirectPlayProfiles || []).filter((p) => String(p.Type || 'Video').toLowerCase() === 'video');
  const matching = direct.find((p) => containerOk(list(p.Container), container) && codecOk(list(p.VideoCodec), video?.Codec) && codecOk(list(p.AudioCodec), audio?.Codec));
  if (!matching) {
    if (!direct.some((p) => containerOk(list(p.Container), container))) reasons.add('ContainerNotSupported');
    else if (!direct.some((p) => containerOk(list(p.Container), container) && codecOk(list(p.VideoCodec), video?.Codec))) reasons.add('VideoCodecNotSupported');
    else reasons.add('AudioCodecNotSupported');
  }
  if (request.EnableDirectPlay === false && request.EnableDirectStream === false) reasons.add('DirectPlayError');

  if (!reasons.size) return { directPlay: true, reasons: [], transcoding: null, copyVideo: true, copyAudio: true };

  // Conversion : le profil HLS de l'app (le seul que Stremfin diffuse).
  const tp = (profile.TranscodingProfiles || []).find((p) => String(p.Type || '').toLowerCase() === 'video' && String(p.Protocol || '').toLowerCase() === 'hls');
  if (!tp || request.EnableTranscoding === false) return { directPlay: true, reasons: [...reasons], transcoding: null, copyVideo: true, copyAudio: true };
  const tVideo = list(tp.VideoCodec);
  const tAudio = list(tp.AudioCodec);
  const maxChannels = Number(tp.MaxAudioChannels) || 2;
  const copyVideo =
    request.AllowVideoStreamCopy !== false &&
    !!video &&
    codecOk(tVideo, video.Codec) &&
    videoOk &&
    !reasons.has('ContainerBitrateExceedsLimit');
  // Son recopie seulement dans un codec que les segments HLS peuvent porter (le MP2 des chaines
  // IPTV, par exemple, est refuse par les navigateurs : bufferAddCodecError).
  const fmp4 = String(tp.Container || 'ts').toLowerCase() === 'mp4';
  const segmentAudio = fmp4 ? ['aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac', 'alac'] : ['aac', 'mp3', 'ac3', 'eac3'];
  const copyAudio =
    request.AllowAudioStreamCopy !== false &&
    (!audio ||
      ((!audio.Codec || codecOk(segmentAudio, String(audio.Codec).toLowerCase())) &&codecOk(tAudio, audio.Codec) && audioOk && (audio.Channels || 2) <= maxChannels));
  return {
    directPlay: false,
    reasons: [...reasons],
    copyVideo,
    copyAudio,
    transcoding: {
      container: String(tp.Container || 'ts').toLowerCase() === 'mp4' ? 'mp4' : 'ts',
      videoCodec: 'h264',
      audioCodec: tAudio.includes('aac') || !tAudio.length ? 'aac' : tAudio[0],
      maxAudioChannels: maxChannels,
      maxBitrate
    }
  };
}

/** La version se lirait-elle telle quelle (d'apres son nom) ? Pour choisir une release compatible. */
function playsDirect(streams, container, request) {
  return decide({ streams, container, request }).directPlay;
}

module.exports = { decide, playsDirect };
