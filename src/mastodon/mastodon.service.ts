import { Injectable, HttpException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { IMastodon } from './mastodon.models';
import { Model } from 'mongoose';
import * as Mastodon from 'mastodon-api';

@Injectable()
export class MastodonService {
  private readonly logger = new Logger(MastodonService.name);

  constructor(@InjectModel('Mastodon') private readonly mastodonModel: Model<IMastodon>) {}

  public async authorizeClient(website: string, code: string): Promise<any> {
    const model: IMastodon = await this.mastodonModel.findOne({ website });
    if (!model) {
      throw new HttpException(`Tried to authorize a client to an unregistered instance: ${website}`, 400);
    }

    try {
      const accessToken = await Mastodon.getAccessToken(model.client_id, model.client_secret, code, website);
      return accessToken;
    } catch (err) {
      this.logger.error(`Unable to authorize client on ${website}\n${JSON.stringify(err)}`);
      throw new HttpException(`Unable to authorize ${website} at this time`, 500);
    }
  }

  public async generateAuthRedirect(website: string): Promise<string> {
    const model: IMastodon = await this.mastodonModel.findOne({ website });
    if (model) {
      try {
        const authURL = await Mastodon.getAuthorizationUrl(model.client_id, model.client_secret, model.website, 'read write', 'urn:ietf:wg:oauth:2.0:oob');
        return authURL;
      } catch (err) {
        this.logger.error(err);
        throw new HttpException(`Unable to authorize ${website} at this time`, 500);
      }
    } else {
      const oauth = await this.registerMastodonInstance(website);
      if (oauth) {
        try {
          const authURL = await Mastodon.getAuthorizationUrl(oauth.client_id, oauth.client_secret, oauth.website, 'read write', 'urn:ietf:wg:oauth:2.0:oob');
          return authURL;
        } catch (err) {
          this.logger.error(err);
          throw new HttpException(`Unable to authorize ${website} at this time`, 500);
        }
      } else {
        throw new HttpException(`Unable to authorize ${website} at this time`, 500);
      }
    }
  }

  private async registerMastodonInstance(website: string): Promise<IMastodon|null> {
    this.logger.log(`Attempting to register Mastodon Instance: ${website}`);
    try {
      const oauth = await Mastodon.createOAuthApp(`${website}/api/v1/apps`, 'PostyBirb', 'read write');
      const info: IMastodon = {
        website,
        client_id: oauth.client_id,
        client_secret: oauth.client_secret
      };

      const newInstance = new this.mastodonModel(info);
      await newInstance.save();

      return info;
    } catch (err) {
      this.logger.error(`Mastodon Instance Registration (${website}) failed`);
      this.logger.error(err);
      return null; // only resolving to not force a catch block
    }
  }
}
