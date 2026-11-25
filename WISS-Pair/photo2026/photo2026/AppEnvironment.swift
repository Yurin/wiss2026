import Foundation

enum AppEnvironment {
    static let apiBaseURLString = "https://photo-interface.com:8443"
    static let webAppBaseURLString = "https://photo-interface.com:8443"
    static let wsBaseURLString = "wss://photo-interface.com:8443/ws/video"

    static var apiBaseURL: URL {
        URL(string: apiBaseURLString)!
    }

    static var webAppBaseURL: URL {
        URL(string: webAppBaseURLString)!
    }

    static var wsBaseURL: URL {
        URL(string: wsBaseURLString)!
    }

    static let apiBaseURLKey = "WISS_PRODUCTION_SERVER_URL"
    static let webAppBaseURLKey = "WEB_APP_BASE_URL"
    static let wsBaseURLKey = "WS_BASE_URL"
    static let legacyApiBaseURLKey = "ServerBaseURL"
    static let legacyWsBaseURLKey = "WebSocketBaseURL"
}
