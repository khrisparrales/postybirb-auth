import { Injectable, Logger, HttpException } from '@nestjs/common';
import * as TwitterAPI from 'node-twitter-api';
import { OAuth } from 'oauth';
import { TwitterAuthDto, TwitterPostDto, MediaObject } from './twitter.interface';
import * as request from 'request';

@Injectable()
export class TwitterService {
  private readonly logger: Logger = new Logger(TwitterService.name);

  private readonly TWITTER: any = {
    key: process.env.TWITTER_KEY,
    secret: process.env.TWITTER_SECRET,
    authorizer: new TwitterAPI({
      consumerKey: process.env.TWITTER_KEY,
      consumerSecret: process.env.TWITTER_SECRET,
      callback: 'oob',
    }),
  };

  private getAuthGenerator(): any {
    return new OAuth(
      'https://api.twitter.com/oauth/request_token',
      'https://api.twitter.com/oauth/access_token',
      this.TWITTER.key,
      this.TWITTER.secret,
      '1.0',
      'oob',
      'HMAC-SHA1',
    );
  }

  public createOAuth(): Promise<{ token: string, secret: string, url: string }> {
    const oauth = this.getAuthGenerator();
    return new Promise((resolve, reject) => {
      oauth.getOAuthRequestToken((err, oauth_token, oauth_token_secret, results) => {
        if (err) {
          this.logger.error(err);
          reject(new HttpException('Unable to authorize Twitter', 500));
        }

        resolve({
          token: oauth_token,
          secret: oauth_token_secret,
          url: `https://twitter.com/oauth/authenticate?oauth_token=${oauth_token}`
        });
      });
    });
  }

  public authorizePIN(auth: TwitterAuthDto): Promise<{ accessToken: string, accessTokenSecret: string, results: any }> {
    return new Promise((resolve, reject) => {
      this.TWITTER.authorizer.getAccessToken(auth.token, auth.secret, auth.pin, (err, accessToken, accessTokenSecret, results) => {
        if (err) {
          this.logger.error(err);
          reject(new HttpException('Unable to authorize Twitter client', 500));
        }

        resolve({
          accessToken,
          accessTokenSecret,
          results
        });
      });
    });
  }

  public async postStatus(postData: TwitterPostDto): Promise<any> {
    if (postData.status && postData.status.length > 280) {
      throw new HttpException('Status is longer than 280 characters', 400);
    }

    const clientAuth = this.getAuthGenerator();

    // Status with media content
    if (postData.medias && postData.medias.length > 0) {
      const api = new TwitterAPI({
        consumerKey: this.TWITTER.key,
        consumerSecret: this.TWITTER.secret,
        callback: 'oob',
      });

      const uploadPromises = postData.medias.slice(0, 4).map(media => this.uploadMedia(api, clientAuth, media, postData.token, postData.secret));

      try {
        const results = await Promise.all(uploadPromises);
        const res: any = await new Promise((resolve) => {
          clientAuth.post('https://api.twitter.com/1.1/statuses/update.json', postData.token, postData.secret, {
            status: postData.status,
            media_ids: results.slice(0, 4).join(','),
          }, (err, data, resp) => {
            if (err) {
              this.logger.error('Failed to upload image status');
              this.logger.error(err);
              resolve({ error: err });
            } else {
              resolve({});
            }
          });
        });

        if (res.error) {
          throw new HttpException(res.error, 500);
        }

        return res;
      } catch (err) {
        console.log(err)
        this.logger.error(err);
        throw new HttpException(err, 500);
      }
    } else {
      // Normal Status Post
      const res: any = await new Promise((resolve) => {
        clientAuth.post('https://api.twitter.com/1.1/statuses/update.json', postData.token, postData.secret, {
          status: postData.status,
        }, (err, data, r) => {
          if (err) {
            this.logger.error('Failed to upload text status');
            this.logger.error(err);
            resolve({ error: err });
          } else {
            resolve({});
          }
        });
      });

      if (res.error) {
        throw new HttpException(res.error, 500);
      }

      return res;
    }
  }

  private async uploadMedia(api: any, clientAuth: any, media: MediaObject, token: string, secret: string): Promise<string> {
    if (media.type.includes('image') && !media.type.includes('gif')) {
      return await new Promise((resolve, reject) => {
        api.uploadMedia({
          media: media.base64,
          isBase64: true
        }, token, secret, (err, res) => {
          if (err || res.errors) {
            this.logger.error('Failed to upload media');
            err ? this.logger.error(err) : this.logger.error(res);
            reject('Failed to upload media');
          } else {
            resolve(res.media_id_string);
          }
        });
      });
    } else {
      return await this.uploadMediaChunked(clientAuth, media, token, secret);
    }
  }

  /*
  * This is using legacy code from old upload server code because I am too lazy to refactor it right now
  */
  private uploadMediaChunked(auth: any, media: MediaObject, token: string, secret: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const buf = Buffer.from(media.base64, 'base64');
      auth.post('https://upload.twitter.com/1.1/media/upload.json', token, secret, {
        command: 'INIT',
        media_type: media.type,
        total_bytes: buf.length,
        media_category: media.type.includes('gif') ? 'tweet_gif' : 'tweet_video',
      }, (e, data, resp) => {
        if (e) {
          this.logger.error(e);
          reject(e);
        } else {
          let id = null;
          try {
            id = typeof data === 'string' ? JSON.parse(data).media_id_string : data.media_id_string;
          } catch (parseError) {
            reject(parseError);
            return;
          }

          const chunkSize = 1000000;
          const promises = [];

          let segment = 0;
          let offset = 0;
          while (offset < buf.length) {
            const chunk = buf.length < chunkSize ? buf.slice(0, chunkSize) : buf;
            promises.push(this.uploadChunk(segment, chunk, token, secret, id));
            segment += 1;
            offset += chunkSize;
          }

          Promise.all(promises)
            .then(() => {
              auth.post('https://upload.twitter.com/1.1/media/upload.json', token, secret, {
                command: 'FINALIZE',
                media_id: id,
              }, (e, data, resp) => {
                if (e) {
                  this.logger.error('Failed to upload media chunks');
                  this.logger.error(e);
                  reject(e);
                } else {
                  resolve(id);
                }
              });
            })
            .catch((err) => {
              reject('Error uploading chunked media data');
            });
        }
      });
    });
  }

  /*
  * This is using legacy code from old upload server code because I am too lazy to refactor it right now
  */
  private uploadChunk(segment: any, chunk: any, token: string, secret: string, media_id: any) {
    return new Promise((resolve, reject) => {
      const formData = {
        command: 'APPEND',
        media_id,
        media_data: chunk.toString('base64'),
        segment_index: segment,
      };

      const oauth = {
        consumer_key: this.TWITTER.key,
        consumer_secret: this.TWITTER.secret,
        token,
        token_secret: secret,
      };

      request.post({
        url: 'https://upload.twitter.com/1.1/media/upload.json',
        oauth,
        formData,
      }, (err, resp, body) => {
        if (err) {
          this.logger.error(err);
          reject(err);
        } else {
          resolve(true);
        }
      });
    });
  }

}