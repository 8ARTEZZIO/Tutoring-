import Foundation
import KingstonTutoringCore
import Security

/// Device access keys live in the Keychain, readable only on this device after first unlock.
final class KeychainTokenStore: TokenStore {
    struct KeychainError: Error {
        let status: OSStatus
    }

    private let service = "kingston-tutoring.booking-keys"
    private let account = "device-tokens"

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    func load() -> [StoredToken] {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return [] }
        return (try? JSONCoding.decoder().decode([StoredToken].self, from: data)) ?? []
    }

    func save(_ tokens: [StoredToken]) throws {
        let data = try JSONCoding.encoder().encode(tokens)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = baseQuery
            for (key, value) in attributes { item[key] = value }
            let added = SecItemAdd(item as CFDictionary, nil)
            guard added == errSecSuccess else { throw KeychainError(status: added) }
        } else if status != errSecSuccess {
            throw KeychainError(status: status)
        }
    }

    func reset() {
        SecItemDelete(baseQuery as CFDictionary)
    }
}
