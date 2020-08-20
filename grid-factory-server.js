import { Meteor } from 'meteor/meteor'
import { check } from 'meteor/check'
import { FilesCollection } from 'meteor/ostrio:files'
import { getContentDisposition } from './lib/server/getContentDisposition'
import { getGridFsFileId } from './lib/server/getGridFsFileId'

/**
 * Craetes a new factory function to create GridFS-backed FilesCollections.
 * @param i18nFactory {Function} a Function that gets an i18n id + options and may return a translated String
 * @param fs The node file system, injectable for convenience reasons (testing, package deps etc.)
 * @param bucketFactory {Function} A function that returns a valid GridFS bucket by name
 * @param defaultBucket {String} A name for the defaultBucket.
 * @param createObjectId {Function} A function that transform a gridfs id to a valid ObjectId
 * @param onError {Function} A function that receives an error, if any occurred
 * @param debug {Boolean} A flag used to log debug messages to the console
 * @return {function({bucketName?: *, maxSize?: *, extensions?: *, validateUser?: *, validateMime?: *, transformVersions?: *, config?: *}): FilesCollection} Factory Function
 */
export const createGridFilesFactory = ({ i18nFactory, fs, bucketFactory, defaultBucket, createObjectId, onError, debug }) => {
  check(i18nFactory, Function)
  check(fs, Object)
  check(bucketFactory, Function)
  check(defaultBucket, String)
  check(createObjectId, Function)
  check(onError, Match.Maybe(Function))
  check(debug, Match.Maybe(Boolean))

  const log = (...args) => Meteor.isDevelopment && debug && console.info('[FilesCollectionFactory]:', ...args)
  log('set default bucket', defaultBucket)

  const abstractOnError = onError || (e => console.error(e))

  /**
   *
   * @param bucketName
   * @param maxSize
   * @param extensions
   * @param validateUser
   * @param validateMime
   * @param transformVersions
   * @param onError {Function} A function that receives an error, if any occurred, overrides onError from the abstract level
   * @param config override any parameteor for the original FilesCollection constructor
   * @return {FilesCollection}
   */
  const factory = ({ bucketName, maxSize, extensions, validateUser, validateMime, transformVersions, onError, ...config }) => {
    check(bucketName, Match.Maybe(String))
    check(maxSize, Match.Maybe(Number))

    log('create files collection', config.collectionName)

    const onErrorHook = onError || abstractOnError
    const bucket = bucketFactory(bucketName || defaultBucket)
    const maxSizeKb = maxSize && (maxSize / 1024000)

    log('use bucket', bucketName || defaultBucket)
    log('use max size', maxSizeKb)

    const checkSize = (file) => {
      log('check size')
      if (maxSize && file.size > maxSize) {
        return i18nFactory('filesCollection.maxSizeExceed', { maxSize: maxSizeKb })
      }
    }

    const allowedExtensions = extensions && extensions.join(', ')
    const checkExtension = (file) => {
      log('check extension')
      if (extensions && !extensions.includes(file.extension)) {
        log(extensions, file.extension)
        return i18nFactory('filesCollection.invalidExtension', { allowed: allowedExtensions })
      }
    }

    const checkUser = (context, file) => {
      // skip if we don't validate users at all
      if (!validateUser) {
        log('checkUser skipped')
        return
      }

      let hasPermission

      try {
        log('checkUser', context.user, context.userId)
        // we first try to get the current user from the cookies
        // since FilesCollection requires cookies to set the current user
        // if the user exists, we need to pass it with the current file to the hook
        // and wait for a truthy/falsy return value to estimate permission
        const user = context.user && context.user()
        hasPermission = user && validateUser(user, file)
      } catch (validationError) {
        // we need to catch errors, because we can't control the hook environment
        onErrorHook(validationError)
        hasPermission = false
      }

      // if validation failed on any level we return the translated reason for the fail
      if (!hasPermission) {
        return i18nFactory('filesCollection.permissionDenied')
      }
    }

    function beforeUpload (file) {
      log('before upload')
      const self = this

      const sizeChecked = checkSize(file)
      if (typeof sizeChecked !== 'undefined') return sizeChecked

      const extensionChecked = checkExtension(file)
      if (typeof extensionChecked !== 'undefined') return extensionChecked

      const userChecked = checkUser(self, file)
      if (typeof userChecked !== 'undefined') return userChecked

      return true
    }

    function beforeRemove (file) {
      const self = this
      const userChecked = checkUser(self, file)
      return typeof userChecked === 'undefined'
    }

    function afterUpload (file) {
      log('after upload')
      const self = this
      const Collection = self.collection

      // this function passes any occurring error to the onError hook
      // and also unlinks the file from the FS, because we can't be sure
      // if it's still valid to continue to work with it.
      const handleErr = err => {
        onErrorHook(err)
        self.unlink(Collection.findOne(file._id)) // Unlink files from FS
      }

      log('check user')
      const userChecked = checkUser(self, file)
      if (typeof userChecked === 'undefined') {
        return handleErr(new Error(userChecked))
      }

      if (validateMime) {
        log('validate mime')
        try {
          Promise.await(validateMime.call(self, file))
        } catch (mimeErr) {
          handleErr(mimeErr)
        }
      }

      // here you could manipulate your file
      // and create a new version, for example a scaled 'thumbnail'
      if (transformVersions) {
        log('transformVersions')
        try {
          Promise.await(transformVersions.call(self, file))
        } catch (transformErr) {
          return handleErr(transformErr)
        }
      }

      // then we read all versions we have got so far
      Object.keys(file.versions).forEach(versionName => {
        log(`move ${file.name} (${versionName}) to bucket [${bucketName}]`)
        const metadata = { ...file.meta, versionName, fileId: file._id }
        fs.createReadStream(file.versions[versionName].path)

        // this is where we upload the binary to the bucket
          .pipe(bucket.openUploadStream(file.name, { contentType: file.type || 'binary/octet-stream', metadata }))

          // and we unlink the file from the fs on any error
          // that occurred during the upload to prevent zombie files
          .on('error', handleErr)

          // once we are finished, we attach the gridFS Object id on the
          // FilesCollection document's meta section and finally unlink the
          // upload file from the filesystem
          .on('finish', Meteor.bindEnvironment(ver => {
            const property = `versions.${versionName}.meta.gridFsFileId`
            Collection.update(file._id, {
              $set: {
                [property]: ver._id.toHexString()
              }
            })
            self.unlink(Collection.findOne(file._id), versionName) // Unlink files from FS
          }))
      })
    }

    function onProtected (file) {
      const self = this
      const userChecked = checkUser(self, file)
      return typeof userChecked === 'undefined'
    }

    function interceptDownload (http, file, versionName = 'original') {
      const self = this
      log('interceptDownload', file.name, versionName)

      const gridFsFileId = getGridFsFileId(file.versions, versionName)
      if (!gridFsFileId) {
        log('could not get gridFsFileId from ANY version')
        return false
      }

      const gfsId = createObjectId({ gridFsFileId })
      const readStream = bucket.openDownloadStream(gfsId)
      readStream.on('data', (data) => {
        http.response.write(data)
      })

      readStream.on('end', () => {
        http.response.end()
      })

      readStream.on('error', err => {
        onErrorHook(err)
        // not found probably
        // eslint-disable-next-line no-param-reassign
        http.response.statusCode = 404
        http.response.end('not found')
      })

      http.response.setHeader('Cache-Control', self.cacheControl)
      http.response.setHeader('Content-Disposition', getContentDisposition(file.name, http?.params?.query?.download))
      return true
    }

    function afterRemove (files) {
      files.forEach(file => {
        Object.keys(file.versions).forEach(versionName => {
          const gridFsFileId = (file.versions[versionName].meta || {}).gridFsFileId
          if (gridFsFileId) {
            const gfsId = createObjectId({ gridFsFileId })
            bucket.delete(gfsId, onErrorHook)
          }
        })
      })
    }

    const productConfig = Object.assign({
      debug: Meteor.isDevelopment && debug,
      onBeforeUpload: beforeUpload,
      onAfterUpload: afterUpload,
      allowClientCode: false, // Disallow remove files from Client
      interceptDownload: interceptDownload,
      onBeforeRemove: beforeRemove,
      onAfterRemove: afterRemove,
      protected: onProtected
    }, config)

    log('productconfig:')
    log(productConfig)

    return new FilesCollection(productConfig)
  }

  log(`factory created for default bucket [${defaultBucket}]`)

  return factory
}
