import type { Logging } from 'homebridge';

/**
 * Aggregated power metrics for upload to SolarCharge API
 */
export interface AggregatedMetrics {
  solar: number; // kW
  export: number; // kW
  pack: number; // kW (grid import)
  usage: number; // kW (local load)
  soc?: number; // fraction 0-1 (battery state of charge)
}

export interface InverterSettingsPayload {
  sellFrom: number; // E.g. 17 (or 0 if deactivated)
  sellTo: number;   // E.g. 21 (or 0 if deactivated)
  buyFrom: number;  // E.g. 2  (or 0 if deactivated)
  buyTo: number;    // E.g. 6  (or 0 if deactivated)
}

export interface ChargerSettingsPayload {
  from: number; // E.g. 17 (or 0 if deactivated)
  to: number;   // E.g. 21 (or 0 if deactivated)
  amps: number;  // E.g. 6  (or 0 if deactivated)
  voltage: number;  // E.g. 230 (or 690 is three phased charger)
  maxAmps?: number; // Charger max current set in the SC app (falls back to 16)
  profileName?: string; // Detected or selected charger profile, e.g. "Alfen_Eve"
}

/**
 * SolarCharge API client for uploading aggregated inverter telemetry.
 * Handles formatted requests to the SolarCharge backend service.
 */
export class SolarChargeUploader {
  constructor(
    private readonly plantId: string,
    private readonly serialNum: string,
    private readonly log: Logging,
    private readonly baseUrl: string = 'https://groshapp.com/test', // Default test server
    // private readonly baseUrl: string = 'https://compellingsoftware.com/edge', // Production server
    private readonly chargerId?: string, // EV charger ID (chargers use chargerId, not plantId)
  ) {}

  /**
 * Fetches the current inverter settings from the SolarCharge API backend
 * @returns The parsed InverterSettingsPayload or null if the request fails
 */
  public async getInverterSettings(): Promise<InverterSettingsPayload | null> {
    try {
      const params = {
        plantId: this.plantId,
        serialNum: this.serialNum,
        branding: 'sc',
      };
      const queryString = new URLSearchParams(params).toString();
      const url = `${this.baseUrl}/invertersettings?${queryString}`;
      this.log.debug(`Fetching inverter settings from SolarCharge API: ${url}`);
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        this.log.error(`SolarCharge API error fetching settings: ${response.status} ${response.statusText}`);
        return null;
      }

      // The API expects a JSON response that matches your PHP schema (sellFrom, sellTo, buyFrom, buyTo)
      const data = await response.json() as {
      sellFrom?: string | number;
      sellTo?: string | number;
      buyFrom?: string | number;
      buyTo?: string | number;
    };

      if (!data) {
        this.log.error('SolarCharge API returned an empty or invalid JSON response.');
        return null;
      }

      // Implicit logic: If the value is "00" (or disabled), we map it to hour 0
      // Otherwise we convert the text string (e.g. "17") to a pure integer
      const sellFromHour = data.sellFrom !== '00' && data.sellFrom !== undefined ? parseInt(data.sellFrom.toString(), 10) : 0;
      const sellToHour   = data.sellTo   !== '00' && data.sellTo   !== undefined ? parseInt(data.sellTo.toString(), 10) : 0;
    
      const buyFromHour  = data.buyFrom  !== '00' && data.buyFrom  !== undefined ? parseInt(data.buyFrom.toString(), 10) : 0;
      const buyToHour    = data.buyTo    !== '00' && data.buyTo    !== undefined ? parseInt(data.buyTo.toString(), 10) : 0;

      // Define the state (On/Off) based on the implicit "00" rule
      const sellActive = sellFromHour !== 0 || sellToHour !== 0;
      const buyActive  = buyFromHour  !== 0 || buyToHour  !== 0;

      this.log.info(`[API Get] Successfully retrieved configuration -> Sell Active: ${sellActive} (${sellFromHour}-${sellToHour}) | Buy Active: ${buyActive} (${buyFromHour}-${buyToHour})`);

      // Return data formatted precisely according to your InverterSettingsPayload interface
      return {
        sellFrom: sellFromHour,
        sellTo: sellToHour,
        buyFrom: buyFromHour,
        buyTo: buyToHour,
      };

    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error(`Could not fetch inverter settings from SolarCharge API: ${errorMsg}`);
      return null;
    }
  }

  /**
 * Uploads current SPH settings to the SolarCharge API, mapping 0 to "00" implicitly.
 */
  public async setInverterSettings(settings: InverterSettingsPayload, profileName?: string): Promise<void> {
    try {
    // Formats the numbers as 2-digit strings. If the number is 0, it automatically becomes "00"
      const sellFromStr: string = String(settings.sellFrom).padStart(2, '0');
      const sellToStr: string   = String(settings.sellTo).padStart(2, '0');
    
      const buyFromStr: string  = String(settings.buyFrom).padStart(2, '0');
      const buyToStr: string    = String(settings.buyTo).padStart(2, '0');
      const url = `${this.baseUrl}/invertersettings`;
      const response = await fetch(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            plantId: this.plantId,
            serialNum: this.serialNum,
            branding: 'sc',
            profileName,
            sellFrom: sellFromStr,
            sellTo: sellToStr,
            buyFrom: buyFromStr,
            buyTo: buyToStr,
          }),
        },
      );

      if (!response.ok) {
        this.log.error(
          `SolarCharge API error updating settings: ${response.status} ${response.statusText}`,
        );
      } else {
        this.log.debug(`Successfully uploaded inverter settings to SolarCharge API -> Sell: ${sellFromStr}-${sellToStr} | Buy: ${buyFromStr}-${buyToStr}`);
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error(
        `Could not upload inverter settings to SolarCharge API: ${errorMsg}`,
      );
    }
  }

  /**
   * Fetches the current EV charger settings from the SolarCharge API backend.
   * Values are "00"/0 when deactivated.
   */
  public async getChargerSettings(): Promise<ChargerSettingsPayload | null> {
    try {
      const params = {
        chargerId: this.chargerId ?? '',
        serialNum: this.serialNum,
        branding: 'sc',
      };
      const url = `${this.baseUrl}/chargersettings?${new URLSearchParams(params).toString()}`;
      this.log.debug(`Fetching charger settings from SolarCharge API: ${url}`);
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        this.log.error(`SolarCharge API error fetching charger settings: ${response.status} ${response.statusText}`);
        return null;
      }

      const data = await response.json() as {
        from?: string | number;
        to?: string | number;
        amps?: string | number;
        voltage?: string | number;
        maxAmps?: string | number;
        profileName?: string;
      };

      if (!data) {
        this.log.error('SolarCharge API returned an empty or invalid charger settings response.');
        return null;
      }

      const toInt = (v: string | number | undefined): number => {
        const n = v === undefined ? 0 : parseInt(v.toString(), 10);
        return Number.isNaN(n) ? 0 : n;
      };

      const settings: ChargerSettingsPayload = {
        from: toInt(data.from),
        to: toInt(data.to),
        amps: toInt(data.amps),
        voltage: toInt(data.voltage) || 230,
        maxAmps: toInt(data.maxAmps) || undefined,
        profileName: data.profileName || undefined,
      };
      this.log.info(`[API Get] Charger settings -> ${settings.from}-${settings.to} @ ${settings.amps} A, ${settings.voltage} V`);
      return settings;
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error(`Could not fetch charger settings from SolarCharge API: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Uploads current EV charger settings to the SolarCharge API, mapping 0 to "00".
   */
  public async setChargerSettings(settings: ChargerSettingsPayload): Promise<void> {
    try {
      const fromStr = String(settings.from).padStart(2, '0');
      const toStr = String(settings.to).padStart(2, '0');
      const ampsStr = String(settings.amps).padStart(2, '0');
      const response = await fetch(`${this.baseUrl}/chargersettings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chargerId: this.chargerId ?? '',
          serialNum: this.serialNum,
          branding: 'sc',
          profileName: settings.profileName,
          from: fromStr,
          to: toStr,
          amps: ampsStr,
          voltage: settings.voltage,
        }),
      });

      if (!response.ok) {
        this.log.error(`SolarCharge API error updating charger settings: ${response.status} ${response.statusText}`);
      } else {
        this.log.debug(`Successfully uploaded charger settings -> ${fromStr}-${toStr} @ ${ampsStr} A, ${settings.voltage} V`);
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error(`Could not upload charger settings to SolarCharge API: ${errorMsg}`);
    }
  }

  /**
   * Upload averaged metrics to SolarCharge API
   * @param metrics Aggregated power metrics (averaged over polling period)
   * @param startTime Time string in HH:MM format (e.g., "14:05")
   * @param endTime Time string in HH:MM format (e.g., "14:10")
   */
  public async uploadMetrics(
    metrics: AggregatedMetrics,
    startTime: string,
    endTime: string,
  ): Promise<void> {
    const url = `${this.baseUrl}/inverterdata`;
    try {
      const response = await fetch(
        url, 
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            plantId: this.plantId,
            serialNum: this.serialNum,
            branding: 'sc',
            start: startTime, // e.g., "14:05"
            end: endTime, // e.g., "14:10"
            solar: metrics.solar, // Averaged kW (ppv - produced solar power)
            usage: metrics.usage, // Averaged kW (local load consumption)
            export: metrics.export, // Averaged kW (export to grid)
            pack: metrics.pack, // Averaged kW (grid import / battery charge)
            soc: metrics.soc, // Latest battery state of charge as float 0-1
          }),
        },
      );

      if (!response.ok) {
        this.log.error(
          `SolarCharge API error: ${response.status} ${response.statusText}`,
        );
      } else {
        this.log.debug('Successfully uploaded aggregated data to SolarCharge API');
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error(
        `Could not upload data to SolarCharge API: ${errorMsg}`,
      );
    }
  }
}
