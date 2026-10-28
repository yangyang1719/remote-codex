import Foundation

/// Retries only connection establishment. It never replays user operations.
@MainActor final class ConnectionRecovery {
    private var task: Task<Void, Never>?
    private var generation = UUID()
    private let delays: [UInt64]
    private let attempt: () async -> Bool
    var onWaiting: ((Int) -> Void)?
    var isScheduled: Bool { task != nil }
    init(delays: [UInt64] = [1, 2, 4, 8, 15, 30].map { UInt64($0) * 1_000_000_000 }, attempt: @escaping () async -> Bool) {
        self.delays = delays; self.attempt = attempt
    }
    func start(immediate: Bool = false) {
        guard task == nil else { return }
        let token = UUID(); generation = token
        task = Task { @MainActor [weak self] in
            guard let self else { return }
            var index = 0
            while !Task.isCancelled, generation == token {
                let delay = immediate && index == 0 ? 0 : delays[min(index, delays.count - 1)]
                onWaiting?(Int(delay / 1_000_000_000))
                do { try await Task.sleep(nanoseconds: delay) } catch { return }
                guard generation == token, !Task.isCancelled else { return }
                if await attempt() { break }
                index += 1
            }
            if generation == token { task = nil }
        }
    }
    func stop() { generation = UUID(); task?.cancel(); task = nil }
}
