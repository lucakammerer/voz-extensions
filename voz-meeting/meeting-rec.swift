// Records the microphone and all system audio until SIGINT or SIGTERM, then mixes both into one 16 kHz mono m4a.
// SIGUSR1 pauses both tracks and SIGUSR2 resumes them, so nothing said while paused reaches the file.
// usage: meeting-rec <out.m4a> | meeting-rec --watch
import AVFoundation
import CoreAudio

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

func check(_ status: OSStatus, _ what: String) {
  if status != noErr { fail("\(what) failed: \(status)") }
}

func property<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value = initial
  var size = UInt32(MemoryLayout<T>.size)
  check(AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value), "Reading property \(selector)")
  return value
}

final class Track {
  let file: AVAudioFile
  let converter: AVAudioConverter
  let input: AVAudioPCMBuffer
  var ended = false

  init(_ url: URL, _ format: AVAudioFormat) {
    guard let file = try? AVAudioFile(forReading: url),
      let converter = AVAudioConverter(from: file.processingFormat, to: format),
      let input = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 16384)
    else { fail("Cannot read \(url.path)") }
    converter.downmix = true
    (self.file, self.converter, self.input) = (file, converter, input)
  }

  func read(into buffer: AVAudioPCMBuffer) {
    buffer.frameLength = 0
    if ended { return }
    let status = converter.convert(to: buffer, error: nil) { _, inputStatus in
      if (try? self.file.read(into: self.input)) == nil || self.input.frameLength == 0 {
        inputStatus.pointee = .endOfStream
        return nil
      }
      inputStatus.pointee = .haveData
      return self.input
    }
    if status != .haveData { ended = true }
  }
}

func mix(_ first: URL, _ second: URL, into output: URL) {
  let format = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!
  let settings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32000]
  let file: AVAudioFile
  do { file = try AVAudioFile(forWriting: output, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false) } catch { fail("Cannot write \(output.path): \(error)") }
  let tracks = [Track(first, format), Track(second, format)]
  let buffers = tracks.map { _ in AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 16000)! }
  while true {
    for (track, buffer) in zip(tracks, buffers) { track.read(into: buffer) }
    let frames = buffers.map(\.frameLength).max()!
    if frames == 0 { break }
    let sum = buffers[0].floatChannelData![0]
    let other = buffers[1].floatChannelData![0]
    for i in 0..<Int(frames) {
      sum[i] = (i < Int(buffers[0].frameLength) ? sum[i] : 0) + (i < Int(buffers[1].frameLength) ? other[i] : 0)
    }
    buffers[0].frameLength = frames
    do { try file.write(from: buffers[0]) } catch { fail("Writing \(output.path) failed: \(error)") }
  }
}

let arguments = CommandLine.arguments
// `meeting-rec --watch` prints the bundle IDs of the apps using a microphone, comma-separated, whenever they change, until stdin closes
if arguments.count == 2, arguments[1] == "--watch" {
  // Apps quit between listing and reading, so a failed read means the app is gone
  func read<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T? {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value = initial
    var size = UInt32(MemoryLayout<T>.size)
    return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr ? value : nil
  }
  func listening() -> String {
    let system = AudioObjectID(kAudioObjectSystemObject)
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return "" }
    var processes = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &processes) == noErr else { return "" }
    let apps = processes.compactMap { process -> String? in
      guard read(process, kAudioProcessPropertyIsRunningInput, UInt32(0)) == 1 else { return nil }
      return read(process, kAudioProcessPropertyBundleID, "" as CFString).map { $0 as String }
    }
    return Set(apps.filter { !$0.isEmpty }).sorted().joined(separator: ",")
  }
  var last: String?
  // Polling stays simple and costs little next to following every process that comes and goes
  Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
    let apps = listening()
    if apps != last { FileHandle.standardOutput.write((apps + "\n").data(using: .utf8)!) }
    last = apps
  }.fire()
  // Voz restarting extensions closes stdin, so the watcher never outlives them
  Thread {
    while readLine() != nil {}
    exit(0)
  }.start()
  RunLoop.main.run()
}
guard arguments.count == 2 else { fail("usage: meeting-rec <out.m4a>") }
let output = URL(fileURLWithPath: arguments[1])
let micURL = output.appendingPathExtension("mic.caf")
let systemURL = output.appendingPathExtension("system.caf")

var paused = false

let engine = AVAudioEngine()
let micFormat = engine.inputNode.outputFormat(forBus: 0)
var micFile: AVAudioFile? = try? AVAudioFile(forWriting: micURL, settings: micFormat.settings)
guard micFile != nil else { fail("Cannot write \(micURL.path)") }
engine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: micFormat) { buffer, _ in
  if !paused { try? micFile?.write(from: buffer) }
}

let tapDescription = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
tapDescription.uuid = UUID()
tapDescription.isPrivate = true
tapDescription.muteBehavior = .unmuted
var tapID = AudioObjectID(kAudioObjectUnknown)
check(AudioHardwareCreateProcessTap(tapDescription, &tapID), "Creating the system audio tap")

let outputDevice = property(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, AudioObjectID(kAudioObjectUnknown))
let outputUID = property(outputDevice, kAudioDevicePropertyDeviceUID, "" as CFString) as String
let aggregateDescription: [String: Any] = [
  kAudioAggregateDeviceNameKey: "Voz Meeting",
  kAudioAggregateDeviceUIDKey: UUID().uuidString,
  kAudioAggregateDeviceMainSubDeviceKey: outputUID,
  kAudioAggregateDeviceIsPrivateKey: true,
  kAudioAggregateDeviceIsStackedKey: false,
  kAudioAggregateDeviceTapAutoStartKey: true,
  kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
  kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: tapDescription.uuid.uuidString]],
]
var aggregateID = AudioObjectID(kAudioObjectUnknown)
check(AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregateID), "Creating the aggregate device")

var tapStream = property(tapID, kAudioTapPropertyFormat, AudioStreamBasicDescription())
guard let systemFormat = AVAudioFormat(streamDescription: &tapStream) else { fail("Unsupported tap format") }
var systemFile: AVAudioFile? = try? AVAudioFile(forWriting: systemURL, settings: systemFormat.settings, commonFormat: systemFormat.commonFormat, interleaved: systemFormat.isInterleaved)
guard systemFile != nil else { fail("Cannot write \(systemURL.path)") }

var procID: AudioDeviceIOProcID?
check(AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, DispatchQueue(label: "meeting-rec")) { _, input, _, _, _ in
  guard !paused, let buffer = AVAudioPCMBuffer(pcmFormat: systemFormat, bufferListNoCopy: input, deallocator: nil) else { return }
  try? systemFile?.write(from: buffer)
}, "Creating the IO proc")

check(AudioDeviceStart(aggregateID, procID), "Starting system audio")
do { try engine.start() } catch { fail("Starting the microphone failed: \(error)") }

func stop() {
  engine.stop()
  engine.inputNode.removeTap(onBus: 0)
  AudioDeviceStop(aggregateID, procID)
  AudioDeviceDestroyIOProcID(aggregateID, procID!)
  AudioHardwareDestroyAggregateDevice(aggregateID)
  AudioHardwareDestroyProcessTap(tapID)
  micFile?.close()
  systemFile?.close()
  micFile = nil
  systemFile = nil
  mix(micURL, systemURL, into: output)
  try? FileManager.default.removeItem(at: micURL)
  try? FileManager.default.removeItem(at: systemURL)
  exit(0)
}

var sources: [DispatchSourceSignal] = []
let handlers: [Int32: () -> Void] = [SIGINT: stop, SIGTERM: stop, SIGUSR1: { paused = true }, SIGUSR2: { paused = false }]
for (signalNumber, handler) in handlers {
  signal(signalNumber, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
  source.setEventHandler(handler: handler)
  source.resume()
  sources.append(source)
}
dispatchMain()
