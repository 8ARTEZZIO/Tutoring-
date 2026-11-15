import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct HTTPRequest: Sendable, Equatable {
    public var method: String
    public var url: URL
    public var headers: [String: String]
    public var body: Data?
}

public struct HTTPResponse: Sendable {
    public var status: Int
    public var body: Data

    public init(status: Int, body: Data) {
        self.status = status
        self.body = body
    }
}

/// Swappable network layer (a real URLSession in the app, a fake in tests).
public protocol HTTPTransport: Sendable {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse
}

/// URLSession transport with an ephemeral configuration: no cookies, no disk cache.
public final class URLSessionTransport: HTTPTransport, @unchecked Sendable {
    private let session: URLSession

    public init(timeout: TimeInterval = 15) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieAcceptPolicy = .never
        session = URLSession(configuration: configuration)
    }

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        var urlRequest = URLRequest(url: request.url)
        urlRequest.httpMethod = request.method
        for (name, value) in request.headers { urlRequest.setValue(value, forHTTPHeaderField: name) }
        urlRequest.httpBody = request.body
        let session = self.session
        return try await withCheckedThrowingContinuation { continuation in
            let task = session.dataTask(with: urlRequest) { data, response, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                continuation.resume(returning: HTTPResponse(status: status, body: data ?? Data()))
            }
            task.resume()
        }
    }
}

public enum APIError: Error, Equatable, Sendable {
    case offline
    case notALink
    case linkNotValid
    case notFound
    case notCancellable
    case rateLimited
    case server(status: Int, message: String?)
    case invalidResponse

    public var userMessage: String {
        switch self {
        case .offline:
            return "You seem to be offline. Your saved classes are still shown; try again when you're connected."
        case .notALink:
            return "That doesn't look like a private booking link. Copy the whole link from your confirmation email and try again."
        case .linkNotValid:
            return "This link isn't valid any more. It may have been replaced; ask for a new private link."
        case .notFound:
            return "This booking is no longer available on this iPhone."
        case .notCancellable:
            return "This booking can't be cancelled from the app. Please contact support."
        case .rateLimited:
            return "Too many attempts. Please wait a few minutes and try again."
        case .server(_, let message):
            return message ?? "Something went wrong on our side. Please try again later."
        case .invalidResponse:
            return "Something went wrong reading the reply. Please update the app or try again later."
        }
    }
}

public enum RefreshResult: Equatable, Sendable {
    case booking(Booking)
    case revoked
    case invalid
}

public struct APIClient: Sendable {
    public static let maxTokensPerRequest = 20

    public let baseURL: URL
    private let transport: HTTPTransport
    private let userAgent: String

    public init(baseURL: URL, transport: HTTPTransport, userAgent: String = "KingstonTutoring-iOS") {
        self.baseURL = baseURL
        self.transport = transport
        self.userAgent = userAgent
    }

    // MARK: Endpoints

    public func addBooking(link: String) async throws -> (token: String, booking: Booking) {
        let response: LinkResponse = try await call("POST", "api/app/v1/link", body: LinkBody(link: link))
        return (response.token, response.booking)
    }

    /// Current state for each token, in the same order. Sends at most 20 tokens per request.
    public func refresh(tokens: [String]) async throws -> [RefreshResult] {
        var results: [RefreshResult] = []
        var start = 0
        while start < tokens.count {
            let chunk = Array(tokens[start..<min(start + Self.maxTokensPerRequest, tokens.count)])
            let response: RefreshResponse = try await call("POST", "api/app/v1/bookings", body: TokensBody(tokens: chunk))
            guard response.results.count == chunk.count else { throw APIError.invalidResponse }
            for item in response.results {
                if item.ok, let booking = item.booking {
                    results.append(.booking(booking))
                } else if item.error == "revoked" {
                    results.append(.revoked)
                } else {
                    results.append(.invalid)
                }
            }
            start += chunk.count
        }
        return results
    }

    public func requestCancellation(token: String, note: String) async throws -> Booking {
        let response: CancelResponse = try await call("POST", "api/app/v1/cancel-request", body: CancelBody(token: token, note: note))
        guard let booking = response.booking else { throw APIError.invalidResponse }
        return booking
    }

    public func forget(token: String) async throws {
        let _: OkResponse = try await call("POST", "api/app/v1/forget", body: TokenBody(token: token))
    }

    public func config() async throws -> AppConfig {
        try await call("GET", "api/app/v1/config", body: nil as NoBody?)
    }

    // MARK: Plumbing

    private func call<Body: Encodable, Result: Decodable>(_ method: String, _ path: String, body: Body?) async throws -> Result {
        var headers = ["Accept": "application/json", "User-Agent": userAgent]
        var data: Data?
        if let body {
            data = try JSONEncoder().encode(body)
            headers["Content-Type"] = "application/json"
        }
        let request = HTTPRequest(method: method, url: baseURL.appendingPathComponent(path), headers: headers, body: data)
        let response: HTTPResponse
        do {
            response = try await transport.send(request)
        } catch {
            throw APIError.offline
        }
        guard (200..<300).contains(response.status) else { throw Self.error(for: response) }
        do {
            return try JSONCoding.decoder().decode(Result.self, from: response.body)
        } catch {
            throw APIError.invalidResponse
        }
    }

    static func error(for response: HTTPResponse) -> APIError {
        let payload = try? JSONDecoder().decode(ErrorPayload.self, from: response.body)
        switch (response.status, payload?.error) {
        case (0, _): return .offline
        case (400, "not_a_link"?): return .notALink
        case (404, "link_not_valid"?): return .linkNotValid
        case (404, _): return .notFound
        case (409, _): return .notCancellable
        case (429, _): return .rateLimited
        default: return .server(status: response.status, message: payload?.message)
        }
    }
}

private struct NoBody: Encodable {}
private struct LinkBody: Encodable { let link: String }
private struct TokensBody: Encodable { let tokens: [String] }
private struct TokenBody: Encodable { let token: String }
private struct CancelBody: Encodable { let token: String; let note: String }
private struct LinkResponse: Decodable { let token: String; let booking: Booking }
private struct RefreshResponse: Decodable {
    struct Item: Decodable {
        let ok: Bool
        let booking: Booking?
        let error: String?
    }
    let results: [Item]
}
private struct CancelResponse: Decodable { let booking: Booking? }
private struct OkResponse: Decodable { let ok: Bool }
private struct ErrorPayload: Decodable {
    let error: String?
    let message: String?
}
